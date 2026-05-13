/**
 * app/api/regime/refresh/route.ts
 *
 * POST /api/regime/refresh
 * POST /api/regime/refresh?symbol=BTC   (explicit symbol, default BTC)
 *
 * Lightweight on-demand regime classification.
 * Runs ONLY the Regime Detector (A6) for a single symbol.
 * Does NOT run agents A1–A5, confluence engine, or memCache write.
 *
 * Purpose:
 *   The btc-markov-edge bot calls this once per 5-minute candle boundary
 *   to get a fresh regime label without depending on the full dashboard
 *   pipeline being pre-populated.
 *
 * Pipeline:
 *   1. Fetch 1H indicators + quote for the requested symbol (taapi + polygon)
 *   2. Get 1D indicators — from module-level cache if already fetched today,
 *      otherwise fetch fresh (with a 16s taapi rate-limit gap after 1H)
 *   3. Run Regime Detector (A6) for that symbol only
 *   4. Map RegimeSignal → RegimePayload (the shape regime_oracle.py expects)
 *   5. Return JSON
 *
 * Timeout budget (Vercel Pro — 60s limit):
 *   Warm calls (1D cache hit):  ~16s 1H + ~2s GPT = ~18s  ✓
 *   Cold calls (first per day): ~16s 1H + 16s wait + ~15s 1D + ~2s GPT = ~49s  ✓
 *   taapi rate-limit retry adds 15s and can push cold calls to ~65s — if the
 *   1D fetch times out on first boot the route falls back to 1H-only context
 *   for that one call. The next call will have the cache populated.
 *
 * Called by:
 *   services/regime_oracle.py → fetch_regime() → POST /api/regime/refresh
 */

import { NextRequest, NextResponse } from "next/server";
import { fetchAllIndicators }          from "@/lib/taapi";
import { fetchAllIndicators1d }        from "@/lib/taapi1d";
import { fetchAllQuotes }              from "@/lib/polygon";
import { DEFAULT_INDICATOR_CONFIG }    from "@/config/indicators";
import { DEFAULT_INDICATOR_CONFIG_1D } from "@/config/indicators1d";
import { runRegimeDetector }           from "@/lib/agents/regimeDetector";
import { mapRegimeToPermission }       from "@/lib/regime/permissionMap";

// Regime → gate mapping is now in @/lib/regime/permissionMap so this route
// and app/api/regime/[symbol]/route.ts share a single source of truth.
// The shared module also enforces the MIN_RELIABILITY floor (0.50) — which
// this route previously did not, allowing low-reliability regimes to drive
// real sizing decisions. That bug is fixed by routing through the shared
// mapRegimeToPermission function below.

// ─── Module-level 1D cache ────────────────────────────────────────────────────
// 1D indicators (EMA50/200, golden/death cross context) change at most once
// per UTC day. Fetching them on every regime request causes taapi rate-limit
// collisions with the 1H fetch, adding 15s of retry wait every call.
//
// This cache stores the last successful 1D fetch per symbol. On warm calls
// (same UTC day), the cache is returned instantly — no network call, no
// rate-limit collision. On cold calls (first call of the day or after a
// server restart), we fetch fresh with a 16s gap after the 1H fetch to
// clear taapi's rate-limit window.
//
// Why module-level: Vercel reuses warm serverless instances across requests.
// A module-level variable persists across invocations on the same instance,
// giving us free in-process caching without Redis or KV setup.
// If the instance is cold-started, the cache is empty and we fetch fresh.

interface Cache1dEntry {
  data:          Map<string, unknown>;
  fetchedOnDate: string;  // UTC date string "YYYY-MM-DD"
}

const cache1d = new Map<string, Cache1dEntry>();  // keyed by symbol

function utcDateString(): string {
  return new Date().toISOString().slice(0, 10);  // "2026-05-08"
}

async function get1dIndicators(
  symbol:  string,
  assets:  { symbol: string; type: "crypto" | "stock" }[],
): Promise<Map<string, unknown>> {
  const today   = utcDateString();
  const cached  = cache1d.get(symbol);

  if (cached && cached.fetchedOnDate === today) {
    console.log(
      `[regime/refresh] 1D cache hit for ${symbol} ` +
      `(fetched today ${today}) — skipping taapi 1D fetch`
    );
    return cached.data;
  }

  // Cache is cold (first call of the day or fresh instance).
  // Wait 16s after the 1H fetch to clear taapi's rate-limit window before
  // issuing the 1D request. Without this gap, the 1D fetch gets rate-limited
  // and triggers a 15s retry, pushing total response time to ~53s.
  console.log(
    `[regime/refresh] 1D cache cold for ${symbol} ` +
    `(last fetched: ${cached?.fetchedOnDate ?? "never"}) — ` +
    `waiting 16s before 1D fetch to clear taapi rate-limit...`
  );
  await new Promise((r) => setTimeout(r, 16_000));

  try {
    const data = await fetchAllIndicators1d(assets, DEFAULT_INDICATOR_CONFIG_1D);
    cache1d.set(symbol, { data, fetchedOnDate: today });
    console.log(`[regime/refresh] 1D indicators fetched and cached for ${symbol} (${today})`);
    return data;
  } catch (err) {
    // 1D failure is non-fatal — regime detector degrades gracefully to 1H-only.
    // Do NOT cache a failed result; the next call will retry.
    console.warn(
      `[regime/refresh] 1D fetch failed for ${symbol} — ` +
      `using 1H-only context this call: ${err}`
    );
    return new Map();
  }
}

// ─── Derived field helpers ────────────────────────────────────────────────────
// Mirrors computeDerived() and computeDerived1d() in indicatorCache.ts /
// indicatorCache1d.ts. Kept inline here so this route has no dependency on
// the cache singletons (which carry all symbols and auto-refresh timers).

function computeDerived(i: any) {
  const hist = i.macd?.valueMACDHist ?? null;
  return {
    priceAboveEma20:
      i.ema20 != null && i.currentClose != null ? i.currentClose > i.ema20 : null,
    ema20Slope:
      i.ema20 != null && i.prevEma20 != null ? i.ema20 - i.prevEma20 : null,
    ema20PctDist:
      i.ema20 != null && i.currentClose != null && i.ema20 > 0
        ? +((((i.currentClose - i.ema20) / i.ema20) * 100).toFixed(2))
        : null,
    histChange:
      hist != null && i.prevHist != null ? +((hist - i.prevHist).toFixed(6)) : null,
    rsiChange:
      i.rsi != null && i.prevRsi != null ? +((i.rsi - i.prevRsi).toFixed(2)) : null,
    volumeChangePct:
      i.volume != null && i.prevVolume != null && i.prevVolume > 0
        ? +(((( i.volume - i.prevVolume) / i.prevVolume) * 100).toFixed(2))
        : null,
    relativeVolume:       null,   // excluded — volumeSma20 dimensionally incompatible
    volumeExpanding:
      i.volume != null && i.prevVolume != null ? i.volume > i.prevVolume : null,
    volumeAboveAverage:   null,
    atrPct:
      i.atr != null && i.currentClose != null && i.currentClose > 0
        ? +((( i.atr / i.currentClose) * 100).toFixed(3))
        : null,
    distanceFromEmaInAtr:
      i.atr != null && i.atr > 0 && i.currentClose != null && i.ema20 != null
        ? +(((i.currentClose - i.ema20) / i.atr).toFixed(3))
        : null,
    candleRangeInAtr:
      i.atr != null && i.atr > 0 && i.high != null && i.low != null
        ? +(((i.high - i.low) / i.atr).toFixed(3))
        : null,
  };
}

function computeDerived1d(i: any) {
  return {
    priceAboveEma50:
      i.currentClose != null && i.ema50  != null ? i.currentClose > i.ema50  : null,
    priceAboveEma200:
      i.currentClose != null && i.ema200 != null ? i.currentClose > i.ema200 : null,
    ema50AboveEma200:
      i.ema50 != null && i.ema200 != null ? i.ema50 > i.ema200 : null,
    ema50Slope:
      i.ema50  != null && i.prevEma50  != null
        ? +((i.ema50  - i.prevEma50 ).toFixed(4)) : null,
    ema200Slope:
      i.ema200 != null && i.prevEma200 != null
        ? +((i.ema200 - i.prevEma200).toFixed(4)) : null,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const startMs = Date.now();
  const symbol  = (req.nextUrl.searchParams.get("symbol") ?? "BTC").toUpperCase();

  console.log(`[regime/refresh] On-demand regime classification for ${symbol}`);

  const assetType = ["BTC", "ETH", "SOL"].includes(symbol) ? "crypto" : "stock";
  const assets    = [{ symbol, type: assetType as "crypto" | "stock" }];

  // ── Step 1: Fetch 1H indicators + quote (always fresh) ────────────────────
  let indicatorMap: Map<string, unknown>;
  let quoteMap:     Map<string, unknown>;

  try {
    [indicatorMap, quoteMap] = await Promise.all([
      fetchAllIndicators(assets, DEFAULT_INDICATOR_CONFIG),
      fetchAllQuotes(assets),
    ]);
  } catch (err) {
    console.error(`[regime/refresh] 1H indicator fetch failed:`, err);
    return NextResponse.json(
      { success: false, error: "Failed to fetch 1H indicators", detail: String(err) },
      { status: 500 }
    );
  }

  // ── Step 2: Get 1D indicators (cached per UTC day) ────────────────────────
  // Warm path: returns instantly from cache — no taapi call, no rate-limit risk.
  // Cold path: waits 16s after 1H fetch, then calls taapi 1D and caches result.
  const indicatorMap1d = await get1dIndicators(symbol, assets);

  // ── Step 3: Build CacheSnapshot shapes ────────────────────────────────────
  const ind   = indicatorMap.get(symbol)   as any;
  const quote = quoteMap.get(symbol)       as any ?? null;
  const ind1d = indicatorMap1d.get(symbol) as any;

  if (!ind) {
    console.error(`[regime/refresh] No indicator data returned for ${symbol}`);
    return NextResponse.json(
      { success: false, error: `No indicator data for ${symbol}` },
      { status: 500 }
    );
  }

  if (quote?.price  != null) ind.currentClose = quote.price;
  if (quote?.volume != null) ind.volume       = quote.volume;
  if (ind1d && quote?.price != null) ind1d.currentClose = quote.price;

  const snapshot: any = {
    lastUpdated:     new Date().toISOString(),
    refreshing:      false,
    lastFetchFailed: false,
    stockSymbols:    assetType === "stock"  ? [symbol] : [],
    cryptoSymbols:   assetType === "crypto" ? [symbol] : [],
    data: new Map([[symbol, {
      indicators: ind,
      quote,
      derived:    computeDerived(ind),
    }]]),
  };

  const snapshot1d: any = {
    lastUpdated:     new Date().toISOString(),
    refreshing:      false,
    lastFetchFailed: !ind1d,
    stockSymbols:    assetType === "stock"  ? [symbol] : [],
    cryptoSymbols:   assetType === "crypto" ? [symbol] : [],
    data: ind1d
      ? new Map([[symbol, {
          indicators: ind1d,
          quote,
          derived:    computeDerived1d(ind1d),
        }]])
      : new Map(),
  };

  // ── Step 4: Run Regime Detector ────────────────────────────────────────────
  let regimeSignals: Awaited<ReturnType<typeof runRegimeDetector>>;

  try {
    regimeSignals = await runRegimeDetector(snapshot, snapshot1d, [symbol]);
  } catch (err) {
    console.error(`[regime/refresh] Regime detector failed:`, err);
    return NextResponse.json(
      { success: false, error: "Regime detector failed", detail: String(err) },
      { status: 500 }
    );
  }

  const signal = regimeSignals.find((s) => s.symbol === symbol);

  if (!signal) {
    console.error(`[regime/refresh] No regime signal produced for ${symbol}`);
    return NextResponse.json(
      { success: false, error: `Regime detector produced no output for ${symbol}` },
      { status: 500 }
    );
  }

  // ── Step 5: Map to RegimePayload via shared permissionMap ────────────────
  // This routes through the shared mapRegimeToPermission, which now also
  // enforces the MIN_RELIABILITY=0.50 floor. Previously this endpoint had
  // no reliability check; low-confidence regimes drove real sizing.
  // signal.reason is preserved as the user-facing reason for backward
  // compatibility with the Markov bot's payload contract.
  const mapped     = mapRegimeToPermission(signal.regime, signal.reliability);
  const updatedAt  = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  const payload = {
    success:         true,
    symbol,
    regime:          signal.regime,
    reliability:     signal.reliability,
    directionalBias: mapped.directionalBias,
    tradePermission: mapped.tradePermission,
    edgeMultiplier:  mapped.edgeMultiplier,
    sizeMultiplier:  mapped.sizeMultiplier,
    emaContext:      signal.emaContext,
    volContext:      signal.volContext,
    reason:          signal.reason,
    updatedAt,
  };

  console.log(
    `[regime/refresh] ${symbol} → ${signal.regime} ` +
    `(reliability=${signal.reliability.toFixed(2)}, ` +
    `permission=${mapped.tradePermission}, ` +
    `1D cache: ${cache1d.get(symbol)?.fetchedOnDate === utcDateString() ? "warm" : "cold"}, ` +
    `${durationMs}ms)`
  );

  return NextResponse.json(payload);
}
