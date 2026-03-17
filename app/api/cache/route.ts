/**
 * app/api/cache/route.ts
 *
 * Cache status + full indicator/derived snapshot endpoint.
 * SignalsPanel fetches this alongside /api/signals to get raw indicator
 * data for the SignalDetailPanel slide-over.
 */

import { NextResponse }  from "next/server";
import { getCache }      from "@/lib/indicatorCache";

export async function GET() {
  const cache    = getCache();
  const snapshot = cache.read();

  const indicators = Object.fromEntries(
    [...snapshot.data.entries()].map(([sym, entry]) => [sym, entry.indicators])
  );
  const derived = Object.fromEntries(
    [...snapshot.data.entries()].map(([sym, entry]) => [sym, entry.derived])
  );

  return NextResponse.json({
    lastUpdated:     snapshot.lastUpdated,
    refreshing:      snapshot.refreshing,
    lastFetchFailed: snapshot.lastFetchFailed,
    symbolCount:     snapshot.data.size,
    stockSymbols:    snapshot.stockSymbols,
    cryptoSymbols:   snapshot.cryptoSymbols,
    indicators,
    derived,
  });
}