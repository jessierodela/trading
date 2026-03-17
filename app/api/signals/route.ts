/**
 * app/api/signals/route.ts
 *
 * Only exports GET — no non-route exports (Next.js App Router requirement).
 * Cache invalidation lives in lib/signalsCache.ts.
 *
 * Signal persistence:
 *  L1 — In-memory (lib/signalsCache.ts, 90s TTL) — lost on cold start
 *  L2 — Supabase (1hr hold window)               — survives deploys
 *
 * Read order:  L1 → L2 → run GPT-4o → write both
 */

import { NextResponse }                      from "next/server";
import { memCache, MEMORY_TTL_MS }           from "@/lib/signalsCache";
import { getCache }                          from "@/lib/indicatorCache";
import { runMomentumScoutAI }               from "@/lib/agents/momentumScout";
import { persistSignalRun, loadLastSignalRun } from "@/lib/signalStore";
import {
  evaluateSignals,
  type AgentResult,
  type DashboardStats,
  type LiveActivityEntry,
  buildActivityLog,
} from "@/lib/signals";

export async function GET() {
  // L1: in-memory hit
  if (memCache.response && Date.now() < memCache.expiresAt) {
    return NextResponse.json(memCache.response);
  }

  const cache    = getCache();
  const snapshot = cache.read();

  // No indicator data yet — fall back to Supabase
  if (snapshot.data.size === 0) {
    const stored = await loadLastSignalRun();
    if (stored) {
      memCache.response  = stored;
      memCache.expiresAt = Date.now() + MEMORY_TTL_MS;
      return NextResponse.json(stored);
    }
    return NextResponse.json(
      { agentResults: [], stats: null, activity: [] },
      { status: 200 }
    );
  }

  // Cold start with indicator data — check Supabase before running GPT-4o
  if (!memCache.response) {
    const stored = await loadLastSignalRun();
    if (stored) {
      memCache.response  = stored;
      memCache.expiresAt = Date.now() + MEMORY_TTL_MS;
      return NextResponse.json(stored);
    }
  }

  // ── Fresh GPT-4o run ──────────────────────────────────────────────────

  const startMs = Date.now();

  const indicatorMap = new Map(
    [...snapshot.data.entries()].map(([sym, entry]) => [sym, entry.indicators])
  );
  const quoteMap = new Map(
    [...snapshot.data.entries()]
      .filter(([, entry]) => entry.quote !== null)
      .map(([sym, entry]) => [sym, { price: entry.quote!.price }])
  );

  const [a1Signals, legacyResults] = await Promise.all([
    runMomentumScoutAI(snapshot),
    evaluateSignals(
      indicatorMap,
      quoteMap,
      snapshot.stockSymbols,
      snapshot.cryptoSymbols
    ),
  ]);

  const a1Result: AgentResult = {
    id:          "A1",
    name:        "Momentum Scout AI",
    signalCount: a1Signals.length,
    alertCount:  a1Signals.filter((s) => s.confidence === "high").length,
    lastAction:  a1Signals.length
      ? `Flagged ${a1Signals[0].symbol} — ${a1Signals[0].reason.slice(0, 50)}…`
      : "Scanning — no qualifying setups",
    signals: a1Signals,
  };

  const agentResults: AgentResult[] = [
    a1Result,
    ...legacyResults.agentResults.slice(1),
  ];

  const allSignals   = agentResults.flatMap((a) => a.signals);
  const buySignals   = allSignals.filter((s) => s.type === "buy");
  const highConf     = buySignals.filter((s) => s.confidence === "high");
  const activeAgents = agentResults.filter((a) => a.signalCount > 0).length;

  const stats: DashboardStats = {
    activeAgents,
    alertsToday:    allSignals.length,
    buySignals:     buySignals.length,
    highConfidence: highConf.length,
  };

  const activity: LiveActivityEntry[] = buildActivityLog(agentResults);

  const response = {
    agentResults,
    stats,
    activity,
    generatedAt: new Date().toISOString(),
  };

  const durationMs = Date.now() - startMs;

  // Write L1
  memCache.response  = response;
  memCache.expiresAt = Date.now() + MEMORY_TTL_MS;

  // Write L2 — non-blocking, never delays the response
  persistSignalRun({ snapshot, a1Signals, agentResults, durationMs })
    .catch((err) => console.error("[signals] Supabase persist failed:", err));

  return NextResponse.json(response);
}