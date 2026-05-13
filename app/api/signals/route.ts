/**
 * app/api/signals/route.ts
 *
 * READ ONLY — serves the in-memory cache written by POST /api/cache/refresh.
 * No Supabase. No fallback. If the cache is empty, returns empty state.
 */

import { NextResponse }            from "next/server";
import { memCache, MEMORY_TTL_MS } from "@/lib/signalsCache";
import {
  buildActivityLog,
  type AgentResult,
  type DashboardStats,
} from "@/lib/signals";

const TAG = "[api/signals]";

// Currently unused — kept for future wiring. Mirrors the filtering logic
// in /api/cache/refresh: A6 regime signals are not trade alerts and must
// not inflate counts.
function computeStats(agentResults: AgentResult[]): DashboardStats {
  const tradingAgents = agentResults.filter((a) => a.id !== "A6");
  const allSignals    = tradingAgents.flatMap((a) => a.signals);
  const buySignals    = allSignals.filter((s) => s.type === "buy");
  const highConf      = buySignals.filter((s) => s.confidence === "high");
  const activeAgents  = tradingAgents.filter((a) => a.signalCount > 0).length;
  return {
    activeAgents,
    alertsToday:    allSignals.length,
    buySignals:     buySignals.length,
    highConfidence: highConf.length,
  };
}

export async function GET() {
  const reqId = Math.random().toString(36).slice(2, 7);
  console.log(`${TAG} [${reqId}] GET /api/signals`);

  const now = Date.now();
  if (memCache.response && now < memCache.expiresAt) {
    const ttlLeft = ((memCache.expiresAt - now) / 1000).toFixed(1);
    const cached  = memCache.response as { generatedAt: string };
    console.log(`${TAG} [${reqId}] HIT — expires in ${ttlLeft}s, generatedAt=${cached.generatedAt}`);
    return NextResponse.json(memCache.response);
  }

  console.log(`${TAG} [${reqId}] MISS — cache empty or expired, returning empty state`);
  return NextResponse.json({
    agentResults: [],
    stats:        null,
    activity:     [],
    generatedAt:  null,
  });
}
