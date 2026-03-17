/**
 * app/api/signals/route.ts
 *
 * READ ONLY — never triggers GPT-4o directly.
 *
 * Source priority:
 *  L1 — In-memory (90s TTL)     — fastest, lost on cold start
 *  L2 — Supabase (1hr window)   — survives deploys and cold starts
 *  L3 — Empty state             — before first manual refresh
 *
 * GPT-4o is triggered exclusively by POST /api/cache/refresh,
 * which fetches indicators then calls runMomentumScoutAI directly.
 * This keeps the signal route fast and eliminates the cold-start
 * issue where empty indicator cache blocked GPT-4o from running.
 */

import { NextResponse }              from "next/server";
import { memCache, MEMORY_TTL_MS }  from "@/lib/signalsCache";
import { loadLastSignalRun }         from "@/lib/signalStore";
import { buildActivityLog }          from "@/lib/signals";

export async function GET() {
  // L1: in-memory hit
  if (memCache.response && Date.now() < memCache.expiresAt) {
    return NextResponse.json(memCache.response);
  }

  // L2: Supabase — handles cold starts and post-deploy
  const stored = await loadLastSignalRun();
  if (stored) {
    // Warm L1 so subsequent polls don't hit Supabase every time
    memCache.response  = stored;
    memCache.expiresAt = Date.now() + MEMORY_TTL_MS;
    return NextResponse.json({
      ...stored,
      activity: buildActivityLog(stored.agentResults),
    });
  }

  // L3: nothing yet — user needs to hit Refresh
  return NextResponse.json(
    { agentResults: [], stats: null, activity: [], fromStore: false },
    { status: 200 }
  );
}