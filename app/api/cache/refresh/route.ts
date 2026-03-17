/**
 * app/api/cache/refresh/route.ts
 *
 * POST /api/cache/refresh
 *
 * Triggers an immediate manual refresh of the indicator cache.
 * The 5-min auto-timer continues unaffected.
 *
 * Returns the cache status after refresh completes.
 * Client should show a loading state while awaiting — this blocks until done.
 */

import { NextResponse } from "next/server";
import { getCache }     from "@/lib/indicatorCache";

export async function POST() {
  const cache = getCache();

  console.log("[cache/refresh] Manual refresh triggered");
  await cache.forceRefresh();

  const snapshot = cache.read();

  return NextResponse.json({
    success:     !snapshot.lastFetchFailed,
    lastUpdated: snapshot.lastUpdated,
    symbolCount: snapshot.data.size,
  });
}