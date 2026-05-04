/**
 * app/api/cache/refresh/route.ts
 *
 * POST /api/cache/refresh
 *
 * Full pipeline:
 *  1. Fetch indicators (taapi) + quotes (yahoo-finance2)
 *  2. Run Regime Detector (A6) FIRST — emits regime labels + reliability scores
 *  3. Run all other agents (A1–A5) in parallel with regime context available
 *  4. Run confluence engine (deterministic score + GPT narrative per symbol)
 *  5. Write result to memCache
 *  6. Return full signal payload in the response
 *
 * Regime Detector runs before A1–A5 so downstream agents and the confluence
 * engine can read regime context. Reliability scores are passed through to the
 * confluence engine for signal gating.
 *
 * CHANGE LOG:
 *  - Removed evaluateSignals() (legacy hardcoded agent path).
 *  - Agent IDs renumbered A1–A5 to match config/agents.ts.
 *  - Added runConfluenceEngine() — runs after agents, before memCache write.
 *    confluence[] is included in the payload and response.
 *  - Added runRegimeDetector() (A6) — runs before A1–A5, regime context
 *    passed to confluence engine. regimeSignals[] included in payload.
 */

import { NextResponse }            from "next/server";
import { getCache }                from "@/lib/indicatorCache";
import { getCache1d }              from "@/lib/indicatorCache1d";
import { runMomentumScoutAI }      from "@/lib/agents/momentumScout";
import { runBreakoutWatcher }      from "@/lib/agents/breakoutWatcher";
import { runTrendFollower }        from "@/lib/agents/trendFollower";
import { runVolatilityArbiter }    from "@/lib/agents/volatilityArbiter";
import { runMeanReversion }        from "@/lib/agents/meanReversion";
import { runRegimeDetector }       from "@/lib/agents/regimeDetector";
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

  // ── Step 1: Fetch indicators + quotes ─────────────────────────────────────
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
    console.warn("[cache/refresh] 1D fetch failed — Trend Follower and Regime Detector will have reduced 1D context");
  }

  // ── Step 2: Run Regime Detector (A6) FIRST ────────────────────────────────
  // Must complete before A1–A5 so regime context is available for gating.
  // RegimeSignal[] is a superset of Signal[] — safe to pass to buildActivityLog.
  console.log("[cache/refresh] Running Regime Detector (A6)...");

  const a6Signals = await runRegimeDetector(snapshot, snapshot1d);

  console.log(
    `[cache/refresh] Regime Detector complete — ` +
    `${a6Signals.length} regime(s) classified: ` +
    a6Signals.map((s) => `${s.symbol}=${s.regime}(${s.reliability.toFixed(2)})`).join(", ")
  );

  // ── Step 3: Run agents A1–A5 in parallel ──────────────────────────────────
  // All five GPT agents are the sole source of truth for directional signals.
  // Regime context is available in a6Signals if any agent needs it in future.
  console.log("[cache/refresh] Running agents A1–A5...");

  const [a1Signals, a2Signals, a3Signals, a4Signals, a5Signals] = await Promise.all([
    runMomentumScoutAI(snapshot),
    runBreakoutWatcher(snapshot, "1h"),
    runTrendFollower(snapshot1d, "1d"),
    runVolatilityArbiter(snapshot, "1h"),
    runMeanReversion(snapshot),
  ]);

  // ── Step 4: Build AgentResult records ─────────────────────────────────────

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

  const a6Result: AgentResult = {
    id:          "A6",
    name:        "Regime Detector",
    signalCount: a6Signals.length,
    alertCount:  a6Signals.filter((s) => s.reliability >= 0.8).length,
    lastAction:  a6Signals.length
      ? a6Signals
          .map((s) => `${s.symbol}→${s.regime}`)
          .join(", ") + ` (reliability avg: ${(a6Signals.reduce((acc, s) => acc + s.reliability, 0) / a6Signals.length).toFixed(2)})`
      : "No regime data — cache empty",
    signals: a6Signals,
  };

  const agentResults: AgentResult[] = [
    a1Result,
    a2Result,
    a3Result,
    a4Result,
    a5Result,
    a6Result,
  ];

  // ── Step 5: Run confluence engine ──────────────────────────────────────────
  // Collects all agent signals, scores per symbol, calls GPT for narrative.
  // a6Signals are included — confluence engine can read regime + reliability.
  console.log("[cache/refresh] Running confluence engine...");

  const allSignals = agentResults.flatMap((a) => a.signals);
  const confluence = await runConfluenceEngine(allSignals);

  console.log(`[cache/refresh] Confluence complete — ${confluence.length} symbol(s) evaluated`);

  // ── Step 6: Compute dashboard stats ───────────────────────────────────────

  // Exclude A6 regime signals from buy/alert counts (they are context, not trades)
  const tradingSignals = allSignals.filter((s) => s.agent !== "Regime Detector");
  const buySignals     = tradingSignals.filter((s) => s.type === "buy");
  const highConf       = buySignals.filter((s) => s.confidence === "high");

  // activeAgents: count A1–A5 only; A6 active = it produced regime classifications
  const tradingAgents  = agentResults.filter((a) => a.id !== "A6");
  const activeAgents   = tradingAgents.filter((a) => a.signalCount > 0).length;

  const stats: DashboardStats = {
    activeAgents,
    alertsToday:    tradingSignals.length,
    buySignals:     buySignals.length,
    highConfidence: highConf.length,
  };

  const generatedAt = new Date().toISOString();
  const durationMs  = Date.now() - startMs;

  // ── Step 7: Write to memCache ──────────────────────────────────────────────
  const indicators = Object.fromEntries(
    [...snapshot.data.entries()].map(([sym, entry]) => [sym, entry.indicators])
  );
  const derived = Object.fromEntries(
    [...snapshot.data.entries()].map(([sym, entry]) => [sym, entry.derived])
  );

  // Extract regime map for easy consumption by front-end
  const regimeMap = Object.fromEntries(
    a6Signals.map((s) => [s.symbol, {
      regime:      s.regime,
      reliability: s.reliability,
      emaContext:  s.emaContext,
      volContext:  s.volContext,
    }])
  );

  const payload = {
    agentResults,
    confluence,
    regimeMap,   // { [symbol]: { regime, reliability, emaContext, volContext } }
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
    `${a4Signals.length} volatility, ${a5Signals.length} mean-reversion, ` +
    `${a6Signals.length} regime signals, ` +
    `${confluence.length} confluence verdicts, ${durationMs}ms`
  );

  // ── Step 8: Return full payload ────────────────────────────────────────────
  return NextResponse.json({
    success: true,
    durationMs,
    ...payload,
  });
}
