/**
 * app/api/cache/refresh/route.ts
 *
 * POST /api/cache/refresh
 *
 * Full pipeline:
 *  1. Fetch indicators (taapi) + quotes (yahoo-finance2)
 *  2. Run Momentum Scout AI + Breakout Watcher (GPT-4o) in parallel
 *  3. Write result to memCache
 *  4. Return full signal payload in the response
 *
 * The response includes the complete dashboard data so RefreshButton
 * can push it straight to the panel — no poll delay.
 */

import { NextResponse }            from "next/server";
import { getCache }                from "@/lib/indicatorCache";
import { runMomentumScoutAI }      from "@/lib/agents/momentumScout";
import { runBreakoutWatcher }      from "@/lib/agents/breakoutWatcher";
import { memCache, MEMORY_TTL_MS } from "@/lib/signalsCache";
import {
  evaluateSignals,
  buildActivityLog,
  type AgentResult,
  type DashboardStats,
} from "@/lib/signals";

export async function POST() {
  const startMs = Date.now();
  console.log("[cache/refresh] Manual refresh triggered");

  // ── Step 1: Fetch indicators + quotes ───────────────────────────────────
  const cache = getCache();
  await cache.forceRefresh();

  const snapshot = cache.read();

  if (snapshot.lastFetchFailed || snapshot.data.size === 0) {
    return NextResponse.json(
      { success: false, error: "Indicator fetch failed" },
      { status: 500 }
    );
  }

  // ── Step 2: Run agents in parallel ──────────────────────────────────────
  console.log("[cache/refresh] Running agents...");

  const indicatorMap = new Map(
    [...snapshot.data.entries()].map(([sym, entry]) => [sym, entry.indicators])
  );
  const quoteMap = new Map(
    [...snapshot.data.entries()]
      .filter(([, entry]) => entry.quote !== null)
      .map(([sym, entry]) => [sym, { price: entry.quote!.price }])
  );

  const [a1Signals, bwSignals, legacyResults] = await Promise.all([
    runMomentumScoutAI(snapshot),
    runBreakoutWatcher(snapshot, "1h"),
    evaluateSignals(indicatorMap, quoteMap, snapshot.stockSymbols, snapshot.cryptoSymbols),
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

  const bwResult: AgentResult = {
    id:          "A6",
    name:        "Breakout Watcher",
    signalCount: bwSignals.length,
    alertCount:  bwSignals.filter((s) => s.confidence === "high").length,
    lastAction:  bwSignals.length
      ? `Flagged ${bwSignals[0].symbol} — ${bwSignals[0].reason.slice(0, 50)}…`
      : "Scanning — no breakout conditions met",
    signals: bwSignals,
  };

  const agentResults: AgentResult[] = [
    a1Result,
    bwResult,
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

  const generatedAt = new Date().toISOString();
  const durationMs  = Date.now() - startMs;

  // ── Step 3: Write to memCache ────────────────────────────────────────────
  const payload = {
    agentResults,
    stats,
    activity:    buildActivityLog(agentResults),
    generatedAt,
  };

  memCache.response  = payload;
  memCache.expiresAt = Date.now() + MEMORY_TTL_MS;

  console.log(
    `[cache/refresh] Complete — ${a1Signals.length} momentum signals, ` +
    `${bwSignals.length} breakout signals, ${durationMs}ms`
  );

  // ── Step 4: Return full payload ──────────────────────────────────────────
  // RefreshButton receives this directly — no poll needed.
  return NextResponse.json({
    success: true,
    durationMs,
    ...payload,
  });
}
