import { runBreakoutWatcher } from "@/lib/agents/breakoutWatcher";
import { runMeanReversion } from "@/lib/agents/meanReversion";
import { runMomentumScoutAI } from "@/lib/agents/momentumScout";
import { runRegimeDetector, type RegimeSignal } from "@/lib/agents/regimeDetector";
import { runTrendFollower } from "@/lib/agents/trendFollower";
import { runVolatilityArbiter } from "@/lib/agents/volatilityArbiter";
import { runConfluenceEngine, type RegimeMap } from "@/lib/confluence/confluenceEngine";
import { getCache } from "@/lib/indicatorCache";
import type { CacheSnapshot } from "@/lib/indicatorCache";
import { getCache1d } from "@/lib/indicatorCache1d";
import type { CacheSnapshot1d } from "@/lib/indicatorCache1d";
import {
  isOpenAIEnabled,
  isOpenAIRegimeEnabled,
  isOpenAIStrategyAgentsEnabled,
  isOptionalOpenAIError,
  openAIDisabledResult,
  type OpenAISkipReason,
} from "@/lib/openai/config";
import type {
  DashboardRefreshPipelineInput,
  DashboardRefreshPipelineResult,
  DashboardRegimeContext,
} from "@/lib/pipeline/types";
import {
  buildActivityLog,
  evaluateSignals,
  type AgentResult,
  type DashboardStats,
  type Signal,
} from "@/lib/signals";
import { memCache, MEMORY_TTL_MS } from "@/lib/signalsCache";
import {
  classifyDeterministicRegime,
  toPersistableRegime,
} from "@/lib/regime/deterministicRegimeClassifier";

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

function regimeSkipReason(): OpenAISkipReason | null {
  if (!isOpenAIEnabled()) return "openai_disabled";
  if (!process.env.OPENAI_API_KEY) return "openai_api_key_missing";
  return isOpenAIRegimeEnabled() ? null : "openai_regime_disabled";
}

function strategyAgentsSkipReason(): OpenAISkipReason | null {
  if (!isOpenAIEnabled()) return "openai_disabled";
  if (!process.env.OPENAI_API_KEY) return "openai_api_key_missing";
  return isOpenAIStrategyAgentsEnabled() ? null : "openai_strategy_agents_disabled";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function openAIErrorMetadata(err: unknown): Record<string, unknown> {
  if (!isOptionalOpenAIError(err)) return { error: errorMessage(err) };
  return {
    error: err.message,
    code: err.code,
    status: err.status ?? null,
  };
}

function confidenceForReliability(reliability: number): Signal["confidence"] {
  if (reliability >= 0.75) return "high";
  if (reliability >= 0.5) return "medium";
  return "low";
}

function ema20SlopeBucket(value: number | null | undefined): RegimeSignal["emaContext"]["ema20Slope"] {
  if (value == null) return "flat";
  if (value > 0.01) return "rising";
  if (value < -0.01) return "falling";
  return "flat";
}

function atrRegimeBucket(value: number | null | undefined): RegimeSignal["volContext"]["atrRegime"] {
  if (value == null) return "normal";
  if (value < 0.5) return "compressed";
  if (value < 1.5) return "normal";
  if (value < 3.0) return "elevated";
  return "extreme";
}

function buildDeterministicRegimeSignals(
  snapshot: CacheSnapshot,
  snapshot1d: CacheSnapshot1d,
  timestamp: string,
): RegimeSignal[] {
  const symbols = [...snapshot.stockSymbols, ...snapshot.cryptoSymbols];

  return symbols.flatMap((symbol) => {
    const entry = snapshot.data.get(symbol);
    if (!entry) return [];

    const entry1d = snapshot1d.data.get(symbol);
    const classifier = classifyDeterministicRegime({
      symbol,
      timestamp,
      source: "dashboard_cache_deterministic",
      close: entry.indicators.currentClose ?? entry.quote?.price ?? null,
      rsi14: entry.indicators.rsi,
      macdHist: entry.indicators.macd?.valueMACDHist ?? null,
      ema20: entry.indicators.ema20,
      ema20Slope: entry.derived.ema20Slope,
      ema50: entry1d?.indicators.ema50 ?? entry.indicators.ema50,
      ema200: entry1d?.indicators.ema200 ?? entry.indicators.ema200,
      ema50Slope: entry1d?.derived.ema50Slope ?? null,
      ema200Slope: entry1d?.derived.ema200Slope ?? null,
      atrPct: entry.derived.atrPct,
      bbWidth: entry.indicators.bb_width,
      bbWidthPrev: entry.indicators.bb_width_prev,
      relativeVolume20: entry.derived.relativeVolume,
      candleRangeAtr: entry.derived.candleRangeInAtr,
      dailyEma50AboveEma200: entry1d?.derived.ema50AboveEma200 ?? null,
      dailyPriceAboveEma200: entry1d?.derived.priceAboveEma200 ?? null,
    });
    const persisted = toPersistableRegime(classifier);
    const ema50Above200 =
      entry1d?.derived.ema50AboveEma200 ??
      (
        entry.indicators.ema50 != null && entry.indicators.ema200 != null
          ? entry.indicators.ema50 > entry.indicators.ema200
          : null
      );

    return [{
      symbol,
      agent: "Regime Detector",
      type: "watch",
      confidence: confidenceForReliability(persisted.reliability),
      reason: `[${classifier.regime}] ${persisted.reason} | source=deterministic_cache | aiUsed=false`,
      regime: persisted.regime,
      reliability: persisted.reliability,
      emaContext: {
        ema20Slope: ema20SlopeBucket(entry.derived.ema20Slope),
        ema50Above200,
      },
      volContext: {
        atrPct: entry.derived.atrPct,
        atrRegime: atrRegimeBucket(entry.derived.atrPct),
      },
    }];
  });
}

type TradingAgentResults = [AgentResult, AgentResult, AgentResult, AgentResult, AgentResult];

function buildDeterministicAgentResults(snapshot: CacheSnapshot): TradingAgentResults {
  const indicators = new Map([...snapshot.data.entries()].map(([sym, entry]) => [sym, entry.indicators]));
  const quotes = new Map(
    [...snapshot.data.entries()].flatMap(([sym, entry]) => {
      const price = entry.quote?.price ?? entry.indicators.currentClose;
      return price == null ? [] : [[sym, { price }]];
    }),
  );

  return evaluateSignals(
    indicators,
    quotes,
    snapshot.stockSymbols,
    snapshot.cryptoSymbols,
  ).agentResults as TradingAgentResults;
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

  const timestamp = now().toISOString();
  const regimeOpenAISkip = regimeSkipReason();
  let regimeOpenAIStatus: unknown = regimeOpenAISkip
    ? openAIDisabledResult(regimeOpenAISkip)
    : { enabled: true };
  let a6Signals: RegimeSignal[];

  if (regimeOpenAISkip) {
    console.log(`[cache/refresh] Regime Detector OpenAI skipped (${regimeOpenAISkip}); using deterministic classifier`);
    a6Signals = buildDeterministicRegimeSignals(snapshot, snapshot1d, timestamp);
  } else {
    try {
      console.log("[cache/refresh] Running Regime Detector (A6)...");
      a6Signals = await runRegimeDetectorFn(snapshot, snapshot1d);
      if (a6Signals.length === 0) {
        console.warn("[cache/refresh] Regime Detector returned no output; using deterministic classifier");
        regimeOpenAIStatus = { enabled: true, fallback: "deterministic_empty_output" };
        a6Signals = buildDeterministicRegimeSignals(snapshot, snapshot1d, timestamp);
      }
    } catch (err) {
      if (!isOptionalOpenAIError(err)) throw err;
      console.warn("[cache/refresh] Regime Detector optional OpenAI failure; using deterministic classifier", openAIErrorMetadata(err));
      regimeOpenAIStatus = {
        enabled: true,
        fallback: "deterministic_optional_openai_error",
        ...openAIErrorMetadata(err),
      };
      a6Signals = buildDeterministicRegimeSignals(snapshot, snapshot1d, timestamp);
    }
  }

  console.log(
    `[cache/refresh] Regime Detector complete - ` +
      `${a6Signals.length} regime(s) classified: ` +
      a6Signals.map((s) => `${s.symbol}=${s.regime}(${s.reliability.toFixed(2)})`).join(", "),
  );

  const strategyOpenAISkip = strategyAgentsSkipReason();
  let strategyOpenAIStatus: unknown = strategyOpenAISkip
    ? openAIDisabledResult(strategyOpenAISkip)
    : { enabled: true };
  let tradingAgentResults: TradingAgentResults;

  if (strategyOpenAISkip) {
    console.log(`[cache/refresh] Agents A1-A5 OpenAI skipped (${strategyOpenAISkip}); using deterministic evaluator`);
    tradingAgentResults = buildDeterministicAgentResults(snapshot);
  } else {
    try {
      console.log("[cache/refresh] Running agents A1-A5...");
      const [a1Signals, a2Signals, a3Signals, a4Signals, a5Signals] = await Promise.all([
        runMomentumScoutFn(snapshot),
        runBreakoutWatcherFn(snapshot, "1h"),
        runTrendFollowerFn(snapshot1d, "1d"),
        runVolatilityArbiterFn(snapshot, "1h"),
        runMeanReversionFn(snapshot),
      ]);

      tradingAgentResults = [
        buildTradingAgentResult(
          "A1",
          "Momentum Scout",
          "Scanning - no qualifying setups",
          a1Signals,
        ),
        buildTradingAgentResult(
          "A2",
          "Breakout Watcher",
          "Scanning - no breakout conditions met",
          a2Signals,
        ),
        buildTradingAgentResult(
          "A3",
          "Trend Follower",
          "Scanning - no trend structure available",
          a3Signals,
        ),
        buildTradingAgentResult(
          "A4",
          "Volatility Arbiter",
          "Scanning - no volatility conditions met",
          a4Signals,
        ),
        buildTradingAgentResult(
          "A5",
          "Mean Reversion",
          "Scanning - no oversold bounce conditions met",
          a5Signals,
        ),
      ];
    } catch (err) {
      if (!isOptionalOpenAIError(err)) throw err;
      console.warn("[cache/refresh] Agents A1-A5 optional OpenAI failure; using deterministic evaluator", openAIErrorMetadata(err));
      strategyOpenAIStatus = {
        enabled: true,
        fallback: "deterministic_optional_openai_error",
        ...openAIErrorMetadata(err),
      };
      tradingAgentResults = buildDeterministicAgentResults(snapshot);
    }
  }

  const [a1Result, a2Result, a3Result, a4Result, a5Result] = tradingAgentResults;
  const a1Signals = a1Result.signals;
  const a2Signals = a2Result.signals;
  const a3Signals = a3Result.signals;
  const a4Signals = a4Result.signals;
  const a5Signals = a5Result.signals;

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
  const confluenceNarrativeStatus = !isOpenAIEnabled()
    ? openAIDisabledResult("openai_disabled")
    : process.env.OPENAI_API_KEY
      ? { enabled: true }
      : openAIDisabledResult("openai_api_key_missing");

  const payload = {
    agentResults,
    confluence,
    regimeMap,
    stats,
    activity: buildActivityLog(agentResults),
    generatedAt,
    indicators,
    derived,
    openai: {
      regime: regimeOpenAIStatus,
      strategyAgents: strategyOpenAIStatus,
      confluenceNarrative: confluenceNarrativeStatus,
    },
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
