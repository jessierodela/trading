/**
 * app/api/cache/refresh/route.ts
 *
 * POST /api/cache/refresh
 * Triggers a manual indicator cache refresh, then invalidates the
 * signals response cache so the next poll runs GPT-4o immediately.
 */

import { NextResponse }           from "next/server";
import { getCache }               from "@/lib/indicatorCache";
import { invalidateSignalsCache } from "@/lib/signalsCache";

export async function POST() {
  const cache = getCache();

  console.log("[cache/refresh] Manual refresh triggered");
  await cache.forceRefresh();

  const snapshot = cache.read();

  if (!snapshot.lastFetchFailed) {
    invalidateSignalsCache();
  }

  return NextResponse.json({
    success:     !snapshot.lastFetchFailed,
    lastUpdated: snapshot.lastUpdated,
    symbolCount: snapshot.data.size,
  });
}