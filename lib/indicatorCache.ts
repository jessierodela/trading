/**
 * lib/indicatorCache.ts
 *
 * Singleton cache layer for indicator + price data.
 *
 * Pipeline:
 *   taapi.io      → RSI, MACD, EMA20, ATR (+ prev-bar values), volumeSma20
 *   yahoo-finance2 → currentClose, volume, priceAboveEma20, changePct
 *
 * AUTO-REFRESH: disabled for development — manual-only mode.
 * To re-enable for production, set AUTO_REFRESH = true below.
 *
 * Agents read from cache instantly — no waiting on fetches.
 * Manual refresh: POST /api/cache/refresh from the dashboard.
 *
 * Usage:
 *   import { getCache } from "@/lib/indicatorCache";
 *   const cache = getCache();
 *   const snapshot = cache.read();           // instant
 *   await cache.forceRefresh();              // manual pull
 *
 * v2 additions:
 *   Volume fields: volume (yahoo-finance2), prevVolume + volumeSma20 (taapi)
 *                  + 4 derived booleans/numbers in computeDerived
 *   ATR fields:    atrPct, distanceFromEmaInAtr, candleRangeInAtr (derived)
 */

import { fetchAllIndicators, type IndicatorValues } from "@/lib/taapi";
import { fetchAllQuotes,     type PolygonQuote     } from "@/lib/polygon";
import { DEFAULT_INDICATOR_CONFIG }                  from "@/config/indicators";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface CachedSymbolData {
  indicators: IndicatorValues;
  quote:      PolygonQuote | null;
  /** Derived fields — pre-computed so agents don't repeat math */
  derived: {
    // ── Existing ────────────────────────────────────────────────
    priceAboveEma20: boolean | null;  // currentClose > ema20
    ema20Slope:      number  | null;  // ema20 - prevEma20
    ema20PctDist:    number  | null;  // ((close - ema20) / ema20) * 100
    histChange:      number  | null;  // macdHist - prevHist
    rsiChange:       number  | null;  // rsi - prevRsi

    // ── Volume (new) ─────────────────────────────────────────────
    volumeChangePct:    number  | null;  // ((volume - prevVolume) / prevVolume) * 100
    relativeVolume:     number  | null;  // volume / volumeSma20
    volumeExpanding:    boolean | null;  // volume > prevVolume
    volumeAboveAverage: boolean | null;  // volume > volumeSma20

    // ── ATR / Volatility context (new) ───────────────────────────
    atrPct:               number | null;  // (atr / currentClose) * 100
    distanceFromEmaInAtr: number | null;  // (currentClose - ema20) / atr
    candleRangeInAtr:     number | null;  // (high - low) / atr — null if high/low unavailable
  };
}

export interface CacheSnapshot {
  /** ISO timestamp of last successful fetch */
  lastUpdated:   string | null;
  /** Whether a fetch is currently in progress */
  refreshing:    boolean;
  /** Whether the last fetch attempt failed */
  lastFetchFailed: boolean;
  /** Per-symbol data — key is symbol string e.g. "BTC", "AAPL" */
  data:          Map<string, CachedSymbolData>;
  /** All stock symbols tracked */
  stockSymbols:  string[];
  /** All crypto symbols tracked */
  cryptoSymbols: string[];
}

// ─── Assets — keep in sync with your existing asset list ──────────────────

const ASSETS: { symbol: string; type: "stock" | "crypto" }[] = [
  { symbol: "AAPL", type: "stock"  },
  { symbol: "TSLA", type: "stock"  },
  { symbol: "NVDA", type: "stock"  },
  { symbol: "BTC",  type: "crypto" },
  { symbol: "ETH",  type: "crypto" },
];

const STOCK_SYMBOLS  = ASSETS.filter((a) => a.type === "stock" ).map((a) => a.symbol);
const CRYPTO_SYMBOLS = ASSETS.filter((a) => a.type === "crypto").map((a) => a.symbol);

// ─── Mode ──────────────────────────────────────────────────────────────────
// Set AUTO_REFRESH = true when ready for production.
// In manual mode the cache starts empty — data only arrives via forceRefresh().

const AUTO_REFRESH        = false;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (used when AUTO_REFRESH = true)

// ─── Derived field calculator ─────────────────────────────────────────────

function computeDerived(ind: IndicatorValues): CachedSymbolData["derived"] {
  const {
    rsi, macd, ema20, prevRsi, prevHist, prevEma20, currentClose,
    // Volume — volume is overridden by yahoo-finance2 in fetch() below.
    // prevVolume + volumeSma20 come from taapi if "candle"/"volumeSma20" are enabled.
    volume, prevVolume, volumeSma20,
    // ATR + candle range
    atr, high, low,
  } = ind;

  const hist = macd?.valueMACDHist ?? null;

  // ── Existing derived ────────────────────────────────────────────────────

  const priceAboveEma20 =
    ema20 != null && currentClose != null ? currentClose > ema20 : null;

  const ema20Slope =
    ema20 != null && prevEma20 != null ? ema20 - prevEma20 : null;

  const ema20PctDist =
    ema20 != null && currentClose != null && ema20 > 0
      ? +((((currentClose - ema20) / ema20) * 100).toFixed(2))
      : null;

  const histChange =
    hist != null && prevHist != null ? +((hist - prevHist).toFixed(6)) : null;

  const rsiChange =
    rsi != null && prevRsi != null ? +((rsi - prevRsi).toFixed(2)) : null;

  // ── Volume derived ──────────────────────────────────────────────────────
  // All guards are explicit — missing data produces null, not NaN or false.

  const volumeChangePct =
    volume != null && prevVolume != null && prevVolume > 0
      ? +(((( volume - prevVolume) / prevVolume) * 100).toFixed(2))
      : null;

  // volumeSma20 from taapi uses "vwma" which returns a PRICE value (not volume).
  // Dividing yahoo volume by a price is dimensionally wrong — produces 471,000x.
  // relativeVolume and volumeAboveAverage are nulled out here.
  // Use volumeChangePct (volume vs prevVolume) for bar-over-bar volume analysis.
  const relativeVolume = null;

  const volumeExpanding =
    volume != null && prevVolume != null ? volume > prevVolume : null;

  const volumeAboveAverage = null; // excluded — requires valid volumeSma20

  // ── ATR derived ─────────────────────────────────────────────────────────

  const atrPct =
    atr != null && currentClose != null && currentClose > 0
      ? +((( atr / currentClose) * 100).toFixed(3))
      : null;

  const distanceFromEmaInAtr =
    atr != null && atr > 0 && currentClose != null && ema20 != null
      ? +(((currentClose - ema20) / atr).toFixed(3))
      : null;

  // Requires candle high/low — gracefully null if taapi doesn't supply them yet.
  const candleRangeInAtr =
    atr != null && atr > 0 && high != null && low != null
      ? +(((high - low) / atr).toFixed(3))
      : null;

  return {
    // Existing
    priceAboveEma20,
    ema20Slope,
    ema20PctDist,
    histChange,
    rsiChange,
    // Volume
    volumeChangePct,
    relativeVolume,
    volumeExpanding,
    volumeAboveAverage,
    // ATR
    atrPct,
    distanceFromEmaInAtr,
    candleRangeInAtr,
  };
}

// ─── Cache class ───────────────────────────────────────────────────────────

class IndicatorCache {
  private snapshot: CacheSnapshot = {
    lastUpdated:     null,
    refreshing:      false,
    lastFetchFailed: false,
    data:            new Map(),
    stockSymbols:    STOCK_SYMBOLS,
    cryptoSymbols:   CRYPTO_SYMBOLS,
  };

  private timer: ReturnType<typeof setInterval> | null = null;

  // ── Public: read current snapshot instantly ──────────────────────────────
  read(): CacheSnapshot {
    return this.snapshot;
  }

  // ── Public: trigger a manual refresh ────────────────────────────────────
  async forceRefresh(): Promise<void> {
    await this.fetch();
  }

  // ── Public: start the cache (called by getCache on init) ────────────────
  // In manual mode: no-op — cache stays empty until forceRefresh() is called.
  // In auto mode:   fetches immediately, then every REFRESH_INTERVAL_MS.
  start(): void {
    if (!AUTO_REFRESH) {
      console.log("[cache] Manual mode — no auto-refresh. Use POST /api/cache/refresh.");
      return;
    }

    if (this.timer) return; // already running

    console.log("[cache] Auto mode — initial fetch starting...");
    this.fetch();

    this.timer = setInterval(() => {
      console.log("[cache] Auto-refresh triggered");
      this.fetch();
    }, REFRESH_INTERVAL_MS);
  }

  // ── Internal: fetch all data and update snapshot ─────────────────────────
  private async fetch(): Promise<void> {
    if (this.snapshot.refreshing) {
      console.log("[cache] Fetch already in progress — skipping");
      return;
    }

    this.snapshot = { ...this.snapshot, refreshing: true };

    try {
      console.log("[cache] Fetching indicators + quotes...");

      // Run taapi + yahoo-finance2 in parallel where possible.
      // Taapi is slow (rate-limited), so quotes finish first and wait.
      const [indicatorMap, quoteMap] = await Promise.all([
        fetchAllIndicators(ASSETS, DEFAULT_INDICATOR_CONFIG),
        fetchAllQuotes(ASSETS),
      ]);

      const data = new Map<string, CachedSymbolData>();

      for (const { symbol } of ASSETS) {
        const ind   = indicatorMap.get(symbol);
        const quote = quoteMap.get(symbol) ?? null;

        if (!ind) continue;

        // ── yahoo-finance2 overrides ──────────────────────────────────────
        // Prefer the live quote price over taapi's /price — more reliable.
        // Override volume too: yahoo-finance2 regularMarketVolume is the
        // primary volume source; taapi candle volume is a fallback only.
        if (quote?.price != null) {
          ind.currentClose = quote.price;
        }
        if (quote?.volume != null) {
          ind.volume = quote.volume;
        }

        data.set(symbol, {
          indicators: ind,
          quote,
          derived:    computeDerived(ind),
        });
      }

      this.snapshot = {
        lastUpdated:     new Date().toISOString(),
        refreshing:      false,
        lastFetchFailed: false,
        data,
        stockSymbols:    STOCK_SYMBOLS,
        cryptoSymbols:   CRYPTO_SYMBOLS,
      };

      console.log(`[cache] Updated at ${this.snapshot.lastUpdated} — ${data.size} symbols cached`);

    } catch (err) {
      console.error("[cache] Fetch failed:", err);
      this.snapshot = {
        ...this.snapshot,
        refreshing:      false,
        lastFetchFailed: true,
      };
    }
  }
}

// ─── Singleton ─────────────────────────────────────────────────────────────
// Next.js hot-reload creates new module instances in dev.
// Storing on globalThis ensures one instance across reloads.

const GLOBAL_KEY = "__indicatorCache__";

declare global {
  // eslint-disable-next-line no-var
  var __indicatorCache__: IndicatorCache | undefined;
}

export function getCache(): IndicatorCache {
  if (!global[GLOBAL_KEY]) {
    global[GLOBAL_KEY] = new IndicatorCache();
    global[GLOBAL_KEY].start();
  }
  return global[GLOBAL_KEY]!;
}
