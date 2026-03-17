/**
 * app/api/cache/route.ts
 *
 * Cache initialization + status endpoint.
 *
 * GET  /api/cache          → returns cache status (lastUpdated, symbol count, refreshing)
 * POST /api/cache/refresh  → triggers a manual force-refresh (see refresh/route.ts)
 *
 * This route also serves as the startup hook — importing getCache() here
 * ensures the singleton is initialized and the 5-min timer is running
 * from the first request onward, even before /api/signals is called.
 */

import { NextResponse }  from "next/server";
import { getCache }      from "@/lib/indicatorCache";

export async function GET() {
  const cache    = getCache(); // initializes + starts timer on first call
  const snapshot = cache.read();

  return NextResponse.json({
    lastUpdated:     snapshot.lastUpdated,
    refreshing:      snapshot.refreshing,
    lastFetchFailed: snapshot.lastFetchFailed,
    symbolCount:     snapshot.data.size,
    stockSymbols:    snapshot.stockSymbols,
    cryptoSymbols:   snapshot.cryptoSymbols,
    // Per-symbol availability summary (not full data — keep payload small)
    availability: Object.fromEntries(
      [...snapshot.data.entries()].map(([sym, entry]) => [
        sym,
        {
          hasRsi:   entry.indicators.rsi   !== null,
          hasMacd:  entry.indicators.macd  !== null,
          hasEma20: entry.indicators.ema20 !== null,
          hasClose: entry.indicators.currentClose !== null,
          hasQuote: entry.quote !== null,
        },
      ])
    ),
  });
}