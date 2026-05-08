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
 *   pipeline being pre-populated. The full /api/cache/refresh pipeline
 *   is slow (taapi rate-limits, 15s 1H→1D gap, 6 GPT calls) and its
 *   cache goes stale if nobody manually triggers it.
 *
 * Pipeline (this endpoint only):
 *   1. Fetch 1H indicators + quote for the requested symbol (taapi + polygon)
 *   2. Fetch 1D indicators for the same symbol
 *   3. Run Regime Detector (A6) for that symbol only
 *   4. Map RegimeSignal → RegimePayload (the shape regime_oracle.py expects)
 *   5. Return JSON
 *
 * Response shape (matches what regime_oracle.py expects at /api/regime/:symbol):
 *   {
 *     success:          true,
 *     symbol:           "BTC",
 *     regime:           "TREND_UP" | "TREND_DOWN" | "LOW_VOL" | "HIGH_VOL" | "CHOP" | "NEWS_SHOCK",
 *     reliability:      0.0–1.0,
 *     directionalBias:  "UP" | "DOWN" | "NEUTRAL",
 *     tradePermission:  "ALLOW_UP_ONLY" | "ALLOW_DOWN_ONLY" | "ALLOW_BOTH" | "BLOCK_OR_EXCEPTIONAL_ONLY" | "BLOCK",
 *     edgeMultiplier:   1.0 (default — adjusted per regime below),
 *     sizeMultiplier:   1.0 (default — adjusted per regime below),
 *     emaContext:       { ema20Slope: "rising"|"falling"|"flat", ema50Above200: bool|null },
 *     volContext:       { atrPct: number|null, atrRegime: "compressed"|"normal"|"elevated"|"extreme" },
 *     reason:           string,
 *     updatedAt:        ISO 8601,
 *   }
 *
 * Timeout note:
 *   Vercel hobby/pro serverless functions time out at 10s / 60s.
 *   This endpoint skips taapi bulk-fetch and fetches only one symbol,
 *   which is fast enough to fit in 10s on the hobby plan if taapi responds
 *   promptly. If taapi is slow, upgrade to pro (60s limit) or self-host.
 *
 * Called by:
 *   services/regime_oracle.py → fetch_regime() → POST /api/regime/refresh
 */

import { NextRequest, NextResponse } from "next/server";
import { fetchAllIndicators }        from "@/lib/taapi";
import { fetchAllIndicators1d }      from "@/lib/taapi1d";
import { fetchAllQuotes }            from "@/lib/polygon";
import { DEFAULT_INDICATOR_CONFIG }  from "@/config/indicators";
import { DEFAULT_INDICATOR_CONFIG_1D } from "@/config/indicators1d";
import { runRegimeDetector }         from "@/lib/agents/regimeDetector";
import type { RegimeLabel }          from "@/lib/agents/regimeDetector";

// ─── Regime → gate mapping ────────────────────────────────────────────────────
// These are the values regime_oracle.py reads to decide whether to allow a trade,
// adjust the edge threshold, or adjust position size.
//
// Keep in sync with the gate logic in services/regime_oracle.py.

interface RegimeGateConfig {
  tradePermission:  "ALLOW_UP_ONLY" | "ALLOW_DOWN_ONLY" | "ALLOW_BOTH" | "BLOCK_OR_EXCEPTIONAL_ONLY" | "BLOCK";
  directionalBias:  "UP" | "DOWN" | "NEUTRAL";
  edgeMultiplier:   number;   // multiplied against base_epsilon in regime_oracle.py
  sizeMultiplier:   number;   // multiplied against base_size in regime_oracle.py
}

const REGIME_GATE: Record<RegimeLabel, RegimeGateConfig> = {
  TREND_UP: {
    tradePermission: "ALLOW_UP_ONLY",
    directionalBias: "UP",
    edgeMultiplier:  0.9,   // slightly relaxed — trend provides context
    sizeMultiplier:  1.25,  // larger size in confirmed uptrend
  },
  TREND_DOWN: {
    tradePermission: "ALLOW_DOWN_ONLY",
    directionalBias: "DOWN",
    edgeMultiplier:  0.9,
    sizeMultiplier:  1.25,
  },
  LOW_VOL: {
    tradePermission: "ALLOW_BOTH",
    directionalBias: "NEUTRAL",
    edgeMultiplier:  1.0,
    sizeMultiplier:  0.75,  // smaller size — low vol = small moves, tighter edge
  },
  HIGH_VOL: {
    tradePermission: "ALLOW_BOTH",
    directionalBias: "NEUTRAL",
    edgeMultiplier:  1.2,   // demand more edge — vol creates noise
    sizeMultiplier:  0.75,
  },
  CHOP: {
    tradePermission: "BLOCK_OR_EXCEPTIONAL_ONLY",
    directionalBias: "NEUTRAL",
    edgeMultiplier:  2.0,   // must clear 2× threshold to trade in chop
    sizeMultiplier:  0.5,
  },
  NEWS_SHOCK: {
    tradePermission: "BLOCK",
    directionalBias: "NEUTRAL",
    edgeMultiplier:  1.0,
    sizeMultiplier:  0.0,   // no trades during shock
  },
};

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const startMs = Date.now();

  // Symbol from query param, default BTC
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "BTC").toUpperCase();

  console.log(`[regime/refresh] On-demand regime classification for ${symbol}`);

  // ── Step 1: Fetch 1H indicators + quote ────────────────────────────────────
  // We only need this one symbol — pass a single-item asset list so taapi
  // doesn't waste rate-limit slots on symbols the bot doesn't care about.
  const assetType = ["BTC", "ETH", "SOL"].includes(symbol) ? "crypto" : "stock";
  const assets = [{ symbol, type: assetType as "crypto" | "stock" }];

  let indicatorMap: Map<string, unknown>;
  let quoteMap:     Map<string, unknown>;
  let indicatorMap1d: Map<string, unknown>;

  try {
    // Fetch 1H and quotes in parallel — both are fast enough to race.
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

  // ── Step 2: Fetch 1D indicators ────────────────────────────────────────────
  // 1D context (EMA50/200 slope, golden/death cross) is required for the regime
  // detector's macro trend classification. Without it the model falls back to
  // 1H-only context, which degrades classification quality — particularly for
  // TREND_UP / TREND_DOWN vs CHOP disambiguation.
  //
  // We do NOT wait 15s here (the main route does this to avoid taapi rate-limit
  // contention when fetching all assets). Since we're fetching only one symbol,
  // the rate-limit window from the 1H fetch should have cleared.
  try {
    indicatorMap1d = await fetchAllIndicators1d(assets, DEFAULT_INDICATOR_CONFIG_1D);
  } catch (err) {
    // 1D failure is non-fatal — regime detector degrades gracefully.
    console.warn(`[regime/refresh] 1D fetch failed (non-fatal): ${err}`);
    indicatorMap1d = new Map();
  }

  // ── Step 3: Build CacheSnapshot shapes ────────────────────────────────────
  // runRegimeDetector() expects CacheSnapshot and CacheSnapshot1d.
  // We build minimal versions from the fetched data — only the symbol we care about.

  const ind   = indicatorMap.get(symbol) as any;
  const quote = quoteMap.get(symbol)     as any ?? null;
  const ind1d = indicatorMap1d.get(symbol) as any;

  if (!ind) {
    console.error(`[regime/refresh] No indicator data returned for ${symbol}`);
    return NextResponse.json(
      { success: false, error: `No indicator data for ${symbol}` },
      { status: 500 }
    );
  }

  // Override price with live quote — same as indicatorCache.ts does.
  if (quote?.price != null)  ind.currentClose = quote.price;
  if (quote?.volume != null) ind.volume       = quote.volume;
  if (ind1d && quote?.price != null) ind1d.currentClose = quote.price;

  // Inline derived computation (mirrors indicatorCache.ts computeDerived)
  function computeDerived(i: any) {
    const hist = i.macd?.valueMACDHist ?? null;
    return {
      priceAboveEma20:      i.ema20 != null && i.currentClose != null ? i.currentClose > i.ema20 : null,
      ema20Slope:           i.ema20 != null && i.prevEma20 != null    ? i.ema20 - i.prevEma20    : null,
      ema20PctDist:         i.ema20 != null && i.currentClose != null && i.ema20 > 0
                              ? +((((i.currentClose - i.ema20) / i.ema20) * 100).toFixed(2)) : null,
      histChange:           hist != null && i.prevHist != null         ? +((hist - i.prevHist).toFixed(6)) : null,
      rsiChange:            i.rsi != null && i.prevRsi != null         ? +((i.rsi - i.prevRsi).toFixed(2)) : null,
      volumeChangePct:      i.volume != null && i.prevVolume != null && i.prevVolume > 0
                              ? +(((( i.volume - i.prevVolume) / i.prevVolume) * 100).toFixed(2)) : null,
      relativeVolume:       null,   // excluded — volumeSma20 dimensionally incompatible
      volumeExpanding:      i.volume != null && i.prevVolume != null ? i.volume > i.prevVolume : null,
      volumeAboveAverage:   null,
      atrPct:               i.atr != null && i.currentClose != null && i.currentClose > 0
                              ? +((( i.atr / i.currentClose) * 100).toFixed(3)) : null,
      distanceFromEmaInAtr: i.atr != null && i.atr > 0 && i.currentClose != null && i.ema20 != null
                              ? +(((i.currentClose - i.ema20) / i.atr).toFixed(3)) : null,
      candleRangeInAtr:     i.atr != null && i.atr > 0 && i.high != null && i.low != null
                              ? +(((i.high - i.low) / i.atr).toFixed(3)) : null,
    };
  }

  function computeDerived1d(i: any) {
    return {
      priceAboveEma50:  i.currentClose != null && i.ema50  != null ? i.currentClose > i.ema50  : null,
      priceAboveEma200: i.currentClose != null && i.ema200 != null ? i.currentClose > i.ema200 : null,
      ema50AboveEma200: i.ema50 != null && i.ema200 != null         ? i.ema50 > i.ema200         : null,
      ema50Slope:       i.ema50  != null && i.prevEma50  != null ? +((i.ema50  - i.prevEma50 ).toFixed(4)) : null,
      ema200Slope:      i.ema200 != null && i.prevEma200 != null ? +((i.ema200 - i.prevEma200).toFixed(4)) : null,
    };
  }

  // Build minimal CacheSnapshot for the regime detector
  const snapshot: any = {
    lastUpdated:     new Date().toISOString(),
    refreshing:      false,
    lastFetchFailed: false,
    stockSymbols:    assetType === "stock" ? [symbol] : [],
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
    stockSymbols:    assetType === "stock" ? [symbol] : [],
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

  // ── Step 5: Map to RegimePayload ───────────────────────────────────────────
  // regime_oracle.py expects this exact shape.
  const gate = REGIME_GATE[signal.regime];
  const updatedAt = new Date().toISOString();

  const payload = {
    success:         true,
    symbol,
    regime:          signal.regime,
    reliability:     signal.reliability,
    directionalBias: gate.directionalBias,
    tradePermission: gate.tradePermission,
    edgeMultiplier:  gate.edgeMultiplier,
    sizeMultiplier:  gate.sizeMultiplier,
    emaContext:      signal.emaContext,
    volContext:      signal.volContext,
    reason:          signal.reason,
    updatedAt,
  };

  const durationMs = Date.now() - startMs;

  console.log(
    `[regime/refresh] ${symbol} → ${signal.regime} ` +
    `(reliability=${signal.reliability.toFixed(2)}, ` +
    `permission=${gate.tradePermission}, ` +
    `${durationMs}ms)`
  );

  return NextResponse.json(payload);
}
