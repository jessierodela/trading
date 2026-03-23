/**
 * app/api/cache/refresh/route.ts
 *
 * POST /api/cache/refresh
 *
 * Full pipeline:
 *  1. Fetch indicators (taapi) + quotes (yahoo-finance2)
 *  2. Run all agents (GPT-4o) in parallel:
 *       A1  — Momentum Scout
 *       A2  — Breakout Watcher
 *       A3  — Trend Follower
 *       A4  — Volatility Arbiter
 *       A5  — Mean Reversion
 *  3. Run confluence engine (deterministic score + GPT narrative per symbol)
 *  4. Write result to memCache
 *  5. Return full signal payload in the response
 *
 * The response includes the complete dashboard data so RefreshButton
 * can push it straight to the panel — no poll delay.
 *
 * CHANGE LOG:
 *  - Removed evaluateSignals() (legacy hardcoded agent path).
 *  - Agent IDs renumbered A1–A5 to match config/agents.ts.
 *  - Added runConfluenceEngine() — runs after agents, before memCache write.
 *    confluence[] is included in the payload and response.
 */

import { NextResponse }            from "next/server";
import { getCache }                from "@/lib/indicatorCache";
import { getCache1d }              from "@/lib/indicatorCache1d";
import { runMomentumScoutAI }      from "@/lib/agents/momentumScout";
import { runBreakoutWatcher }      from "@/lib/agents/breakoutWatcher";
import { runTrendFollower }        from "@/lib/agents/trendFollower";
import { runVolatilityArbiter }    from "@/lib/agents/volatilityArbiter";
import { runMeanReversion }        from "@/lib/agents/meanReversion";
import { runConfluenceEngine }     from "@/lib/confluence/confluenceEngine";
import { memCache, MEMORY_TTL_MS } from "@/lib/signalsCache";
import {
  buildActivityLog,
  type AgentResult,
  type DashboardStats,
} from "@/lib/signals";

export async function POST() {
  const startMs = Date.now();
  console.log("[cache/refresh] Manual refresh triggered");

  // ── Step 1: Fetch indicators + quotes ───────────────────────────────────
  // 1H fetch runs first. 1D fetch starts 15s after 1H completes so they
  // don't compete for the same taapi rate-limit slot (1 req / 15s free plan).
  const cache   = getCache();
  const cache1d = getCache1d();

  await cache.forceRefresh();

  console.log("[cache/refresh] 1H fetch complete — waiting 15s before 1D fetch...");
  await new Promise((r) => setTimeout(r, 15_000));

  await cache1d.forceRefresh();

  const snapshot   = cache.read();
  const snapshot1d = cache1d.read();

  if (snapshot.lastFetchFailed || snapshot.data.size === 0) {
    return NextResponse.json(
      { success: false, error: "Indicator fetch failed" },
      { status: 500 }
    );
  }

  // 1D fetch failure is non-fatal — Trend Follower will produce no signals
  // but the rest of the pipeline continues normally.
  if (snapshot1d.lastFetchFailed) {
    console.warn("[cache/refresh] 1D fetch failed — Trend Follower will be skipped this cycle");
  }

  // ── Step 2: Run agents in parallel ──────────────────────────────────────
  // All five GPT agents are the sole source of truth.
  console.log("[cache/refresh] Running agents...");

  const [a1Signals, a2Signals, a3Signals, a4Signals, a5Signals] = await Promise.all([
    runMomentumScoutAI(snapshot),
    runBreakoutWatcher(snapshot, "1h"),
    runTrendFollower(snapshot1d, "1d"),
    runVolatilityArbiter(snapshot, "1h"),
    runMeanReversion(snapshot),
  ]);

  // ── Step 3: Build AgentResult records ───────────────────────────────────

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

  const a2Result: AgentResult = {
    id:          "A2",
    name:        "Breakout Watcher",
    signalCount: a2Signals.length,
    alertCount:  a2Signals.filter((s) => s.confidence === "high").length,
    lastAction:  a2Signals.length
      ? `Flagged ${a2Signals[0].symbol} — ${a2Signals[0].reason.slice(0, 50)}…`
      : "Scanning — no breakout conditions met",
    signals: a2Signals,
  };

  const a3Result: AgentResult = {
    id:          "A3",
    name:        "Trend Follower",
    signalCount: a3Signals.length,
    alertCount:  a3Signals.filter((s) => s.confidence === "high").length,
    lastAction:  a3Signals.length
      ? `Flagged ${a3Signals[0].symbol} — ${a3Signals[0].reason.slice(0, 50)}…`
      : "Scanning — no trend structure available",
    signals: a3Signals,
  };

  const a4Result: AgentResult = {
    id:          "A4",
    name:        "Volatility Arbiter",
    signalCount: a4Signals.length,
    alertCount:  a4Signals.filter((s) => s.confidence === "high").length,
    lastAction:  a4Signals.length
      ? `Flagged ${a4Signals[0].symbol} — ${a4Signals[0].reason.slice(0, 50)}…`
      : "Scanning — no volatility conditions met",
    signals: a4Signals,
  };

  const a5Result: AgentResult = {
    id:          "A5",
    name:        "Mean Reversion",
    signalCount: a5Signals.length,
    alertCount:  a5Signals.filter((s) => s.confidence === "high").length,
    lastAction:  a5Signals.length
      ? `Flagged ${a5Signals[0].symbol} — ${a5Signals[0].reason.slice(0, 50)}…`
      : "Scanning — no oversold bounce conditions met",
    signals: a5Signals,
  };

  const agentResults: AgentResult[] = [
    a1Result,
    a2Result,
    a3Result,
    a4Result,
    a5Result,
  ];

  // ── Step 4: Run confluence engine ────────────────────────────────────────
  // Collects all agent signals, scores per symbol, calls GPT for narrative.
  // Runs after agents complete — reads Signal[] only, no indicator fetching.
  console.log("[cache/refresh] Running confluence engine...");

  const allSignals = agentResults.flatMap((a) => a.signals);
  const confluence = await runConfluenceEngine(allSignals);

  console.log(`[cache/refresh] Confluence complete — ${confluence.length} symbol(s) evaluated`);

  // ── Step 5: Compute dashboard stats ─────────────────────────────────────

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

  // ── Step 6: Write to memCache ────────────────────────────────────────────
  const indicators = Object.fromEntries(
    [...snapshot.data.entries()].map(([sym, entry]) => [sym, entry.indicators])
  );
  const derived = Object.fromEntries(
    [...snapshot.data.entries()].map(([sym, entry]) => [sym, entry.derived])
  );

  const payload = {
    agentResults,
    confluence,   // ConfluenceResult[] — one entry per symbol that met the gate
    stats,
    activity:    buildActivityLog(agentResults),
    generatedAt,
    indicators,
    derived,
  };

  memCache.response  = payload;
  memCache.expiresAt = Date.now() + MEMORY_TTL_MS;

  console.log(
    `[cache/refresh] Complete — ${a1Signals.length} momentum, ` +
    `${a2Signals.length} breakout, ${a3Signals.length} trend, ` +
    `${a4Signals.length} volatility, ${a5Signals.length} mean-reversion signals, ` +
    `${confluence.length} confluence verdicts, ${durationMs}ms`
  );

  // ── Step 7: Return full payload ──────────────────────────────────────────
  return NextResponse.json({
    success: true,
    durationMs,
    ...payload,
  });
}
