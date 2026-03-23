/**
 * lib/indicatorCache1d.ts
 *
 * Singleton cache for 1D (daily) indicator data.
 * Mirrors the architecture of indicatorCache.ts but for the daily interval.
 *
 * TTL: 24 hours — daily bars don't change until the next UTC day close.
 * Manual refresh: POST /api/cache/refresh calls forceRefresh() on this cache
 * alongside the 1h cache, so both stay in sync on manual trigger.
 *
 * Only Trend Follower reads from this cache.
 * All other agents continue to read from the 1h indicatorCache.
 *
 * Usage:
 *   import { getCache1d } from "@/lib/indicatorCache1d";
 *   const cache1d = getCache1d();
 *   const snapshot = cache1d.read();      // instant
 *   await cache1d.forceRefresh();         // triggers 1D fetch
 */

import { fetchAllIndicators1d }           from "@/lib/taapi1d";
import { fetchAllQuotes, type PolygonQuote } from "@/lib/polygon";
import { DEFAULT_INDICATOR_CONFIG_1D }    from "@/config/indicators1d";
import type { IndicatorValues }           from "@/lib/taapi";

// ─── Types ────────────────────────────────────────────────────────────────────
// Re-uses the same CachedSymbolData / CacheSnapshot shape as indicatorCache.ts
// so agents can consume both snapshots with identical code.

export interface CachedSymbolData1d {
  indicators: IndicatorValues;
  quote:      PolygonQuote | null;
  /** Minimal derived fields relevant to 1D Trend Follower context */
  derived: {
    priceAboveEma50:  boolean | null;
    priceAboveEma200: boolean | null;
    ema50AboveEma200: boolean | null;
    ema50Slope:       number  | null; // ema50 - prevEma50
    ema200Slope:      number  | null; // ema200 - prevEma200
  };
}

export interface CacheSnapshot1d {
  lastUpdated:     string | null;
  refreshing:      boolean;
  lastFetchFailed: boolean;
  data:            Map<string, CachedSymbolData1d>;
  stockSymbols:    string[];
  cryptoSymbols:   string[];
}

// ─── Assets ───────────────────────────────────────────────────────────────────
// Must match the symbols in DEFAULT_INDICATOR_CONFIG_1D that have enabled indicators.
// Keeping the full list here allows easy expansion — disabled symbols are filtered
// out automatically by fetchAllIndicators1d.

const ASSETS: { symbol: string; type: "stock" | "crypto" }[] = [
  { symbol: "AAPL", type: "stock"  },
  { symbol: "TSLA", type: "stock"  },
  { symbol: "NVDA", type: "stock"  },
  { symbol: "BTC",  type: "crypto" },
  { symbol: "ETH",  type: "crypto" },
];

const STOCK_SYMBOLS  = ASSETS.filter((a) => a.type === "stock" ).map((a) => a.symbol);
const CRYPTO_SYMBOLS = ASSETS.filter((a) => a.type === "crypto").map((a) => a.symbol);

// ─── Derived calculator ───────────────────────────────────────────────────────

function computeDerived1d(ind: IndicatorValues): CachedSymbolData1d["derived"] {
  const { ema50, ema200, prevEma50, prevEma200, currentClose } = ind;

  const priceAboveEma50 =
    currentClose != null && ema50 != null ? currentClose > ema50 : null;

  const priceAboveEma200 =
    currentClose != null && ema200 != null ? currentClose > ema200 : null;

  const ema50AboveEma200 =
    ema50 != null && ema200 != null ? ema50 > ema200 : null;

  const ema50Slope =
    ema50 != null && prevEma50 != null ? +(( ema50  - prevEma50 ).toFixed(4)) : null;

  const ema200Slope =
    ema200 != null && prevEma200 != null ? +((ema200 - prevEma200).toFixed(4)) : null;

  return { priceAboveEma50, priceAboveEma200, ema50AboveEma200, ema50Slope, ema200Slope };
}

// ─── Cache class ──────────────────────────────────────────────────────────────

class IndicatorCache1d {
  private snapshot: CacheSnapshot1d = {
    lastUpdated:     null,
    refreshing:      false,
    lastFetchFailed: false,
    data:            new Map(),
    stockSymbols:    STOCK_SYMBOLS,
    cryptoSymbols:   CRYPTO_SYMBOLS,
  };

  read(): CacheSnapshot1d {
    return this.snapshot;
  }

  async forceRefresh(): Promise<void> {
    await this.fetch();
  }

  // Manual-only mode — no auto-refresh timer.
  // Daily data doesn't need polling; manual refresh keeps it current.
  start(): void {
    console.log("[cache1d] Manual mode — no auto-refresh. Triggered via POST /api/cache/refresh.");
  }

  private async fetch(): Promise<void> {
    if (this.snapshot.refreshing) {
      console.log("[cache1d] Fetch already in progress — skipping");
      return;
    }

    this.snapshot = { ...this.snapshot, refreshing: true };

    try {
      console.log("[cache1d] Fetching 1D indicators + quotes...");

      // Fetch 1D indicators from taapi1d. Quotes from yahoo-finance2 are shared
      // with the 1h cache — we fetch them again here to keep this cache self-contained
      // and avoid a cross-cache dependency.
      const [indicatorMap, quoteMap] = await Promise.all([
        fetchAllIndicators1d(ASSETS, DEFAULT_INDICATOR_CONFIG_1D),
        fetchAllQuotes(ASSETS),
      ]);

      const data = new Map<string, CachedSymbolData1d>();

      for (const { symbol } of ASSETS) {
        const ind   = indicatorMap.get(symbol);
        const quote = quoteMap.get(symbol) ?? null;

        if (!ind) continue;

        // Override currentClose with live quote price — same as 1h cache.
        if (quote?.price != null) ind.currentClose = quote.price;

        data.set(symbol, {
          indicators: ind,
          quote,
          derived:    computeDerived1d(ind),
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

      console.log(`[cache1d] Updated at ${this.snapshot.lastUpdated} — ${data.size} symbols cached`);

    } catch (err) {
      console.error("[cache1d] Fetch failed:", err);
      this.snapshot = { ...this.snapshot, refreshing: false, lastFetchFailed: true };
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __indicatorCache1d__: IndicatorCache1d | undefined;
}

export function getCache1d(): IndicatorCache1d {
  if (!global.__indicatorCache1d__) {
    global.__indicatorCache1d__ = new IndicatorCache1d();
    global.__indicatorCache1d__.start();
  }
  return global.__indicatorCache1d__!;
}
