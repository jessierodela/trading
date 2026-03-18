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

const TAG = "[api/signals]";

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
  const reqId = Math.random().toString(36).slice(2, 7); // short ID to correlate logs per request
  console.log(`${TAG} [${reqId}] GET /api/signals`);

  // ── L1: in-memory cache ──────────────────────────────────────────────────
  const now = Date.now();
  if (memCache.response && now < memCache.expiresAt) {
    const ttlLeft = ((memCache.expiresAt - now) / 1000).toFixed(1);
    console.log(`${TAG} [${reqId}] L1 HIT — returning memCache (expires in ${ttlLeft}s, generatedAt=${memCache.response.generatedAt})`);
    return NextResponse.json(memCache.response);
  }

  if (memCache.response) {
    console.log(`${TAG} [${reqId}] L1 MISS — memCache expired ${((now - memCache.expiresAt) / 1000).toFixed(1)}s ago`);
  } else {
    console.log(`${TAG} [${reqId}] L1 MISS — memCache is empty`);
  }

  // ── L2: Supabase ─────────────────────────────────────────────────────────
  console.log(`${TAG} [${reqId}] L2 — calling loadLastSignalRun()...`);
  let stored: Awaited<ReturnType<typeof loadLastSignalRun>>;
  try {
    stored = await loadLastSignalRun();
  } catch (err) {
    console.error(`${TAG} [${reqId}] L2 ERROR — loadLastSignalRun threw:`, err);
    return NextResponse.json(
      { agentResults: [], stats: null, activity: [], fromStore: false, error: "supabase_load_failed" },
      { status: 200 }
    );
  }

  if (stored) {
    console.log(
      `${TAG} [${reqId}] L2 HIT — generatedAt=${stored.generatedAt}, agents=${stored.agentResults.length}`
    );
    const response = buildResponse(stored.agentResults, stored.generatedAt, true);
    memCache.response  = response;
    memCache.expiresAt = now + MEMORY_TTL_MS;
    console.log(`${TAG} [${reqId}] L1 populated — expires in ${(MEMORY_TTL_MS / 1000).toFixed(0)}s`);
    return NextResponse.json(response);
  }

  // ── L3: nothing yet ───────────────────────────────────────────────────────
  console.warn(`${TAG} [${reqId}] L2 MISS — no stored run found in Supabase. Returning empty state.`);
  return NextResponse.json(
    { agentResults: [], stats: null, activity: [], fromStore: false },
    { status: 200 }
  );
}
