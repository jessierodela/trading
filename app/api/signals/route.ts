/**
 * app/api/signals/route.ts
 *
 * READ ONLY — never triggers GPT-4o directly.
 *
 * Always recomputes stats + activity from agentResults before responding
 * so StatsBar and AgentGrid always have accurate counts regardless of
 * whether data came from L1 memory, L2 Supabase, or a fresh run.
 */

import { NextResponse }             from "next/server";
import { memCache, MEMORY_TTL_MS } from "@/lib/signalsCache";
import { loadLastSignalRun }        from "@/lib/signalStore";
import {
  buildActivityLog,
  type AgentResult,
  type DashboardStats,
} from "@/lib/signals";

function computeStats(agentResults: AgentResult[]): DashboardStats {
  const allSignals   = agentResults.flatMap((a) => a.signals);
  const buySignals   = allSignals.filter((s) => s.type === "buy");
  const highConf     = buySignals.filter((s) => s.confidence === "high");
  const activeAgents = agentResults.filter((a) => a.signalCount > 0).length;
  return {
    activeAgents,
    alertsToday:    allSignals.length,
    buySignals:     buySignals.length,
    highConfidence: highConf.length,
  };
}

function buildResponse(agentResults: AgentResult[], generatedAt: string, fromStore = false) {
  return {
    agentResults,
    stats:    computeStats(agentResults),
    activity: buildActivityLog(agentResults),
    generatedAt,
    fromStore,
  };
}

export async function GET() {
  // L1: in-memory hit
  if (memCache.response && Date.now() < memCache.expiresAt) {
    return NextResponse.json(memCache.response);
  }

  // L2: Supabase
  const stored = await loadLastSignalRun();
  if (stored) {
    const response = buildResponse(stored.agentResults, stored.generatedAt, true);
    memCache.response  = response;
    memCache.expiresAt = Date.now() + MEMORY_TTL_MS;
    return NextResponse.json(response);
  }

  // L3: nothing yet
  return NextResponse.json(
    { agentResults: [], stats: null, activity: [], fromStore: false },
    { status: 200 }
  );
}