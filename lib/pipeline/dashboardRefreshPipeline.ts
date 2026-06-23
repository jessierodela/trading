import { runBreakoutWatcher } from "@/lib/agents/breakoutWatcher";
import { runMeanReversion } from "@/lib/agents/meanReversion";
import { runMomentumScoutAI } from "@/lib/agents/momentumScout";
import { runRegimeDetector } from "@/lib/agents/regimeDetector";
import { runTrendFollower } from "@/lib/agents/trendFollower";
import { runVolatilityArbiter } from "@/lib/agents/volatilityArbiter";
import { runConfluenceEngine, type RegimeMap } from "@/lib/confluence/confluenceEngine";
import { getCache } from "@/lib/indicatorCache";
import { getCache1d } from "@/lib/indicatorCache1d";
import type {
  DashboardRefreshPipelineInput,
  DashboardRefreshPipelineResult,
  DashboardRegimeContext,
} from "@/lib/pipeline/types";
import { buildActivityLog, type AgentResult, type DashboardStats, type Signal } from "@/lib/signals";
import { memCache, MEMORY_TTL_MS } from "@/lib/signalsCache";

const DEFAULT_WAIT_BEFORE_1D_MS = 15_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortReason(signal: Signal): string {
  return signal.reason.slice(0, 50);
}

function buildTradingAgentResult(
  id: AgentResult["id"],
  name: AgentResult["name"],
  emptyAction: string,
  signals: Signal[],
): AgentResult {
  return {
    id,
    name,
    signalCount: signals.length,
    alertCount: signals.filter((s) => s.confidence === "high").length,
    lastAction: signals.length
      ? `Flagged ${signals[0].symbol} \u2014 ${shortReason(signals[0])}\u2026`
      : emptyAction,
    signals,
  };
}

export async function runDashboardRefreshPipeline(
  input: DashboardRefreshPipelineInput = {},
): Promise<DashboardRefreshPipelineResult> {
  const nowMs = input.nowMs ?? Date.now;
  const now = input.now ?? (() => new Date());
  const sleepMs = input.sleepMs ?? defaultSleep;
  const waitBefore1dMs = input.waitBefore1dMs ?? DEFAULT_WAIT_BEFORE_1D_MS;
  const writeMemCache = input.writeMemCache ?? true;
  const startMs = nowMs();

  console.log("[cache/refresh] Manual refresh triggered");

  const cache = input.cache ?? getCache();
  const cache1d = input.cache1d ?? getCache1d();

  await cache.forceRefresh();

  console.log("[cache/refresh] 1H fetch complete - waiting 15s before 1D fetch...");
  await sleepMs(waitBefore1dMs);

  await cache1d.forceRefresh();

  const snapshot = cache.read();
  const snapshot1d = cache1d.read();

  if (snapshot.lastFetchFailed || snapshot.data.size === 0) {
    return {
      ok: false,
      status: 500,
      body: { success: false, error: "Indicator fetch failed" },
    };
  }

  if (snapshot1d.lastFetchFailed) {
    console.warn(
      "[cache/refresh] 1D fetch failed - Trend Follower and Regime Detector will have reduced 1D context",
    );
  }

  const runRegimeDetectorFn = input.runRegimeDetectorFn ?? runRegimeDetector;
  const runMomentumScoutFn = input.runMomentumScoutFn ?? runMomentumScoutAI;
  const runBreakoutWatcherFn = input.runBreakoutWatcherFn ?? runBreakoutWatcher;
  const runTrendFollowerFn = input.runTrendFollowerFn ?? runTrendFollower;
  const runVolatilityArbiterFn = input.runVolatilityArbiterFn ?? runVolatilityArbiter;
  const runMeanReversionFn = input.runMeanReversionFn ?? runMeanReversion;
  const runConfluenceEngineFn = input.runConfluenceEngineFn ?? runConfluenceEngine;

  console.log("[cache/refresh] Running Regime Detector (A6)...");
  const a6Signals = await runRegimeDetectorFn(snapshot, snapshot1d);

  console.log(
    `[cache/refresh] Regime Detector complete - ` +
      `${a6Signals.length} regime(s) classified: ` +
      a6Signals.map((s) => `${s.symbol}=${s.regime}(${s.reliability.toFixed(2)})`).join(", "),
  );

  console.log("[cache/refresh] Running agents A1-A5...");
  const [a1Signals, a2Signals, a3Signals, a4Signals, a5Signals] = await Promise.all([
    runMomentumScoutFn(snapshot),
    runBreakoutWatcherFn(snapshot, "1h"),
    runTrendFollowerFn(snapshot1d, "1d"),
    runVolatilityArbiterFn(snapshot, "1h"),
    runMeanReversionFn(snapshot),
  ]);

  const a1Result = buildTradingAgentResult(
    "A1",
    "Momentum Scout",
    "Scanning \u2014 no qualifying setups",
    a1Signals,
  );
  const a2Result = buildTradingAgentResult(
    "A2",
    "Breakout Watcher",
    "Scanning \u2014 no breakout conditions met",
    a2Signals,
  );
  const a3Result = buildTradingAgentResult(
    "A3",
    "Trend Follower",
    "Scanning \u2014 no trend structure available",
    a3Signals,
  );
  const a4Result = buildTradingAgentResult(
    "A4",
    "Volatility Arbiter",
    "Scanning \u2014 no volatility conditions met",
    a4Signals,
  );
  const a5Result = buildTradingAgentResult(
    "A5",
    "Mean Reversion",
    "Scanning \u2014 no oversold bounce conditions met",
    a5Signals,
  );

  const a6AverageReliability =
    a6Signals.length > 0
      ? a6Signals.reduce((acc, s) => acc + s.reliability, 0) / a6Signals.length
      : 0;
  const a6Result: AgentResult = {
    id: "A6",
    name: "Regime Detector",
    signalCount: a6Signals.length,
    alertCount: a6Signals.filter((s) => s.reliability >= 0.8).length,
    lastAction: a6Signals.length
      ? a6Signals.map((s) => `${s.symbol}\u2192${s.regime}`).join(", ") +
        ` (reliability avg: ${a6AverageReliability.toFixed(2)})`
      : "No regime data \u2014 cache empty",
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

  console.log("[cache/refresh] Running confluence engine...");

  const regimeMap: Record<string, DashboardRegimeContext> = Object.fromEntries(
    a6Signals.map((s) => [
      s.symbol,
      {
        regime: s.regime,
        reliability: s.reliability,
        emaContext: s.emaContext,
        volContext: s.volContext,
      },
    ]),
  );

  const tradingSignals = agentResults.filter((a) => a.id !== "A6").flatMap((a) => a.signals);

  const regimeCtxForEngine = Object.fromEntries(
    Object.entries(regimeMap).map(([sym, ctx]) => [
      sym,
      {
        regime: ctx.regime,
        reliability: ctx.reliability,
      },
    ]),
  ) as RegimeMap;

  const confluence = await runConfluenceEngineFn(tradingSignals, regimeCtxForEngine);

  console.log(`[cache/refresh] Confluence complete - ${confluence.length} symbol(s) evaluated`);

  const buySignals = tradingSignals.filter((s) => s.type === "buy");
  const highConf = buySignals.filter((s) => s.confidence === "high");
  const tradingAgents = agentResults.filter((a) => a.id !== "A6");
  const activeAgents = tradingAgents.filter((a) => a.signalCount > 0).length;

  const stats: DashboardStats = {
    activeAgents,
    alertsToday: tradingSignals.length,
    buySignals: buySignals.length,
    highConfidence: highConf.length,
  };

  const generatedAt = now().toISOString();
  const durationMs = nowMs() - startMs;

  const indicators = Object.fromEntries(
    [...snapshot.data.entries()].map(([sym, entry]) => [sym, entry.indicators]),
  );
  const derived = Object.fromEntries(
    [...snapshot.data.entries()].map(([sym, entry]) => [sym, entry.derived]),
  );

  const payload = {
    agentResults,
    confluence,
    regimeMap,
    stats,
    activity: buildActivityLog(agentResults),
    generatedAt,
    indicators,
    derived,
  };

  if (writeMemCache) {
    memCache.response = payload;
    memCache.expiresAt = nowMs() + MEMORY_TTL_MS;
  }

  console.log(
    `[cache/refresh] Complete - ${a1Signals.length} momentum, ` +
      `${a2Signals.length} breakout, ${a3Signals.length} trend, ` +
      `${a4Signals.length} volatility, ${a5Signals.length} mean-reversion, ` +
      `${a6Signals.length} regime signals, ` +
      `${confluence.length} confluence verdicts, ${durationMs}ms`,
  );

  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      durationMs,
      ...payload,
    },
  };
}
