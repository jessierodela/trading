/**
 * app/api/cache/refresh/route.ts
 *
 * POST /api/cache/refresh
 *
 * Full pipeline:
 *  1. Fetch indicators (taapi) + quotes (yahoo-finance2)
 *  2. Run Momentum Scout, Breakout Watcher, Trend Follower (GPT-4o) in parallel
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
import { runTrendFollower }        from "@/lib/agents/trendFollower";
import { runVolatilityArbiter }    from "@/lib/agents/volatilityArbiter";
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

  const [a1Signals, bwSignals, tfSignals, vaSignals, legacyResults] = await Promise.all([
    runMomentumScoutAI(snapshot),
    runBreakoutWatcher(snapshot, "1h"),
    runTrendFollower(snapshot, "1h"),
    runVolatilityArbiter(snapshot, "1h"),
    evaluateSignals(indicatorMap, quoteMap, snapshot.stockSymbols, snapshot.cryptoSymbols),
  ]);

  const a1Result: AgentResult = {
    id:          "A1",
    name:        "Momentum Scout",
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

  const tfResult: AgentResult = {
    id:          "A7",
    name:        "Trend Follower",
    signalCount: tfSignals.length,
    alertCount:  tfSignals.filter((s) => s.confidence === "high").length,
    lastAction:  tfSignals.length
      ? `Flagged ${tfSignals[0].symbol} — ${tfSignals[0].reason.slice(0, 50)}…`
      : "Scanning — no trend structure available",
    signals: tfSignals,
  };

  const vaResult: AgentResult = {
    id:          "A8",
    name:        "Volatility Arbiter",
    signalCount: vaSignals.length,
    alertCount:  vaSignals.filter((s) => s.confidence === "high").length,
    lastAction:  vaSignals.length
      ? `Flagged ${vaSignals[0].symbol} — ${vaSignals[0].reason.slice(0, 50)}…`
      : "Scanning — no volatility conditions met",
    signals: vaSignals,
  };

  const agentResults: AgentResult[] = [
    a1Result,
    bwResult,
    tfResult,
    vaResult,
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
  // Serialize indicators + derived from the snapshot so the response is
  // self-contained — SignalsPanel reads everything from this one response
  // and never needs a separate /api/cache fetch that could hit a cold instance.
  const indicators = Object.fromEntries(
    [...snapshot.data.entries()].map(([sym, entry]) => [sym, entry.indicators])
  );
  const derived = Object.fromEntries(
    [...snapshot.data.entries()].map(([sym, entry]) => [sym, entry.derived])
  );

  const payload = {
    agentResults,
    stats,
    activity:    buildActivityLog(agentResults),
    generatedAt,
    indicators,
    derived,
  };

  memCache.response  = payload;
  memCache.expiresAt = Date.now() + MEMORY_TTL_MS;

  console.log(
    `[cache/refresh] Complete — ${a1Signals.length} momentum signals, ` +
    `${bwSignals.length} breakout signals, ${tfSignals.length} trend signals, ` +
    `${vaSignals.length} volatility signals, ${durationMs}ms`
  );

  // ── Step 4: Return full payload ──────────────────────────────────────────
  // RefreshButton receives signals + indicators in one atomic response.
  return NextResponse.json({
    success: true,
    durationMs,
    ...payload,
  });
}
