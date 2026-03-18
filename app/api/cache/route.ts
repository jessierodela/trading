/**
 * app/api/cache/route.ts
 *
 * Cache status + full indicator/derived snapshot endpoint.
 * SignalsPanel fetches this alongside /api/signals to get raw indicator
 * data for the SignalDetailPanel slide-over.
 */

import { NextResponse }  from "next/server";
import { getCache }      from "@/lib/indicatorCache";

const TAG = "[api/cache]";

export async function GET() {
  console.log(`${TAG} GET /api/cache`);

  const cache    = getCache();
  const snapshot = cache.read();

  console.log(
    `${TAG} snapshot — lastUpdated=${snapshot.lastUpdated ?? "never"}, ` +
    `refreshing=${snapshot.refreshing}, lastFetchFailed=${snapshot.lastFetchFailed}, ` +
    `symbols=${snapshot.data.size}`
  );

  if (snapshot.refreshing) {
    console.log(`${TAG} NOTE: cache is currently refreshing`);
  }
  if (snapshot.lastFetchFailed) {
    console.warn(`${TAG} WARNING: last fetch failed — data may be stale`);
  }

  const indicators = Object.fromEntries(
    [...snapshot.data.entries()].map(([sym, entry]) => [sym, entry.indicators])
  );
  const derived = Object.fromEntries(
    [...snapshot.data.entries()].map(([sym, entry]) => [sym, entry.derived])
  );

  console.log(`${TAG} returning ${snapshot.data.size} symbol(s): [${[...snapshot.data.keys()].join(", ")}]`);

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
