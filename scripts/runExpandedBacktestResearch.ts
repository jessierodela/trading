import fs from "node:fs";
import path from "node:path";
import { getPgPool, PgBarStore, PgFeatureStore } from "@/lib/storage";
import { closePgPool } from "@/lib/storage/clients";
import { FEATURE_VERSION } from "@/lib/versions";
import type { Bar, Exchange, FeatureSnapshot, RegimeContext, RegimeLabel, Timeframe } from "@/lib/quant/types";
import { STRATEGY_REGISTRY } from "@/lib/strategies/strategyRegistry";
import { runBacktest } from "@/lib/backtest/backtestEngine";
import { runPortfolioBacktest, type PortfolioBacktestConfig } from "@/lib/backtest/portfolioBacktest";
import {
  DEFAULT_A6_REGIME_ROUTER_CONFIG,
  defaultA6RegimeRouter,
} from "@/lib/backtest/strategyRouter";
import {
  buildOhlcvProxyRegimes,
  REQUIRED_REGIMES,
  runRegimeValidation,
  type AggregatedRegimeMetrics,
  type RegimeCandidateWindow,
  type RegimeValidationOptions,
  type RegimeValidationResult,
  type RegimeValidationSource,
} from "@/lib/backtest/regimeValidation";
import type { BacktestAssetType, BacktestConfig, BacktestInput, BacktestMetrics, SimulatedTrade } from "@/lib/backtest/types";

interface InstrumentArg {
  symbol: string;
  exchange: Exchange;
  assetType: BacktestAssetType;
  dataSource: string;
}

interface RoutingSummary {
  label: string;
  samples: number;
  avgReturn: number | null;
  avgDrawdown: number | null;
  avgProfitFactor: number | null;
  avgExpectancy: number | null;
  avgTrades: number | null;
  avgExposure: number | null;
  avgReturnToDrawdown: number | null;
}

interface FullStats {
  label: string;
  samples: number;
  avgReturn: number | null;
  medianReturn: number | null;
  maxDrawdown: number | null;
  avgDrawdown: number | null;
  globalProfitFactor: number | null;
  avgProfitFactor: number | null;
  globalExpectancy: number | null;
  avgExpectancy: number | null;
  avgExposure: number | null;
  tradeCount: number;
  noTradeWindows: number;
  avgReturnToDrawdown: number | null;
}

interface RegimePurityStats {
  minDominantRegimePct: number | null;
  medianDominantRegimePct: number | null;
  avgDominantRegimePct: number | null;
  perRegime: Partial<Record<RegimeLabel, {
    samples: number;
    min: number | null;
    median: number | null;
    avg: number | null;
  }>>;
}

type RegimeSourceDisplay =
  | "gpt_a6_detector_snapshots"
  | "deterministic_proxy_research_snapshots"
  | "ohlcv_fallback_labels";

interface PersistedRegimeContext extends RegimeContext {
  regimeModelVersion: string | null;
  promptVersion: string | null;
  rawResponse: unknown;
}

interface RouterWindowAuditRow {
  regime: RegimeLabel;
  startTs: string;
  endTs: string;
  tradeCount: number;
  selectedStrategies: string;
  returnPct: number;
  maxDrawdownPct: number;
  profitFactor: number | null;
  expectancy: number | null;
  grossProfit: number;
  grossLossAbs: number;
  exposurePct: number | null;
}

interface RouterMetricAudit {
  windows: number;
  noTradeWindows: number;
  nonNullProfitFactorWindows: number;
  noLossProfitFactorWindows: number;
  tinyLossProfitFactorWindows: number;
  reportedAverageProfitFactor: number | null;
  globalProfitFactor: number | null;
  averageExpectancy: number | null;
  globalExpectancy: number | null;
  averageReturnPct: number | null;
  totalReturnPct: number | null;
  totalTrades: number;
  selectedStrategyCounts: Record<string, number>;
  rows: RouterWindowAuditRow[];
}

interface ValidationWarningContext {
  requestedWindowsPerRegime: number;
  configuredWindowBars: number;
  effectiveWindowBars: number;
  selectedWindows: RegimeCandidateWindow[];
  aggregates: AggregatedRegimeMetrics[];
  regimeSource: RegimeValidationSource;
  clampedWindowBars: boolean;
}

const MIN_PROXY_WINDOW_BARS = 72;
const DEFAULT_PROXY_WINDOW_BARS = 144;
const NEAR_ZERO_TRADES_PER_WINDOW = 0.25;
const TINY_GROSS_LOSS_USD = 1;

const PORTFOLIO_REGIME_WEIGHTS: NonNullable<PortfolioBacktestConfig["regimeWeights"]> = {
  TREND_UP: { breakout_expansion: 0.6, momentum_continuation: 0.4 },
  TREND_DOWN: { momentum_continuation: 1 },
  HIGH_VOL: { mean_reversion_bounce: 0.7, trend_pullback: 0.3 },
  LOW_VOL: { mean_reversion_bounce: 1 },
  NEWS_SHOCK: { momentum_continuation: 1 },
  CHOP: { momentum_continuation: 0.5, mean_reversion_bounce: 0.5 },
};

interface RunConfig {
  label: string;
  windowBars: number;
  minDominantRegimePct: number;
}

interface ConfigRunResult {
  config: RunConfig;
  validation: RegimeValidationResult;
  totalWindows: number;
  windowsByRegime: Record<RegimeLabel, number>;
  purity: RegimePurityStats;
  staticFull: FullStats[];
  routerFull: FullStats;
  routerAudit: RouterMetricAudit;
  portfolioFull: FullStats[];
}

const RUN_CONFIGS: RunConfig[] = [
  { label: "144b/50%", windowBars: 144, minDominantRegimePct: 50 },
  { label: "144b/65%", windowBars: 144, minDominantRegimePct: 65 },
  { label: "336b/50%", windowBars: 336, minDominantRegimePct: 50 },
  { label: "336b/65%", windowBars: 336, minDominantRegimePct: 65 },
];

function parseInstruments(): InstrumentArg[] {
  const symbols = (process.env.SYMBOLS ?? "BTC-USD")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const exchange = (process.env.EXCHANGE ?? "COINBASE") as Exchange;
  return symbols.map((symbol) => ({
    symbol,
    exchange,
    assetType: (process.env.ASSET_TYPE ?? (symbol.includes("-USD") ? "CRYPTO" : "EQUITY")) as BacktestAssetType,
    dataSource: process.env.DATA_SOURCE ?? "postgres",
  }));
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function fmt(value: number | null | undefined, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

async function fetchBounds(symbol: string, exchange: Exchange, timeframe: Timeframe): Promise<{ startTs: string; endTs: string } | null> {
  const pool = getPgPool();
  const { rows } = await pool.query<{ min_ts: Date | null; max_ts: Date | null }>(
    `select min(ts) as min_ts, max(ts) as max_ts
     from market_bars
     where symbol = $1 and exchange = $2 and timeframe = $3`,
    [symbol, exchange, timeframe],
  );
  const row = rows[0];
  if (!row?.min_ts || !row.max_ts) return null;
  return {
    startTs: row.min_ts.toISOString(),
    endTs: new Date(row.max_ts.getTime() + 60 * 60 * 1000).toISOString(),
  };
}

async function fetchRegimes(symbol: string, exchange: Exchange, startTs: string, endTs: string): Promise<PersistedRegimeContext[]> {
  const pool = getPgPool();
  const { rows } = await pool.query<{
    ts: Date;
    regime: RegimeLabel;
    reliability: string;
    regime_model_version: string | null;
    prompt_version: string | null;
    raw_response: unknown;
  }>(
    `select distinct on (ts)
       ts, regime, reliability, regime_model_version, prompt_version, raw_response
     from regime_snapshots
     where symbol = $1 and exchange = $2 and ts >= $3 and ts < $4
       and (feature_version is null or feature_version = $5)
     order by ts asc, inserted_at desc`,
    [symbol, exchange, startTs, endTs, FEATURE_VERSION],
  );
  return rows.map((row) => ({
    ts: row.ts.toISOString(),
    regime: row.regime,
    reliability: Number(row.reliability),
    regimeModelVersion: row.regime_model_version,
    promptVersion: row.prompt_version,
    rawResponse: row.raw_response,
  }));
}

function baseConfig(instrument: InstrumentArg, startTs: string, endTs: string): BacktestConfig {
  return {
    symbol: instrument.symbol,
    exchange: instrument.exchange,
    assetType: instrument.assetType,
    dataSource: instrument.dataSource,
    timeframe: "1h",
    strategyId: STRATEGY_REGISTRY[0].id,
    featureVersion: FEATURE_VERSION,
    startTs,
    endTs,
    initialCapital: Number(process.env.INITIAL_CAPITAL ?? 10_000),
    riskPerTradePct: Number(process.env.RISK_PER_TRADE_PCT ?? 0.005),
    maxPositionPct: Number(process.env.MAX_POSITION_PCT ?? 1),
    maxConcurrentPositions: 1,
    feeBps: Number(process.env.FEE_BPS ?? 10),
    slippageBps: Number(process.env.SLIPPAGE_BPS ?? 5),
    defaultRewardRisk: Number(process.env.DEFAULT_REWARD_RISK ?? 2),
    closeOpenPositionAtEnd: true,
    enterOnNextBarOpen: true,
    sameBarStopFirst: true,
  };
}

function sliceInput(
  base: BacktestInput,
  window: RegimeCandidateWindow,
  strategyId: string,
): BacktestInput {
  return {
    config: { ...base.config, strategyId, startTs: window.startTs, endTs: window.endTs },
    bars: base.bars.filter((bar) => bar.ts >= window.startTs && bar.ts < window.endTs),
    features: base.features.filter((feature) => feature.ts >= window.startTs && feature.ts < window.endTs),
    dailyFeatures: base.dailyFeatures?.filter((feature) => feature.ts < window.endTs),
    regimes: base.regimes?.filter((regime) => regime.ts <= window.endTs),
  };
}

function summarizeMetrics(label: string, metrics: BacktestMetrics[]): RoutingSummary {
  return {
    label,
    samples: metrics.length,
    avgReturn: avg(metrics.map((m) => m.totalReturnPct)),
    avgDrawdown: avg(metrics.map((m) => m.maxDrawdownPct)),
    avgProfitFactor: avg(metrics.map((m) => m.profitFactor).filter((value): value is number => value !== null)),
    avgExpectancy: avg(metrics.map((m) => m.expectancy).filter((value): value is number => value !== null)),
    avgTrades: avg(metrics.map((m) => m.numberOfTrades)),
    avgExposure: avg(metrics.map((m) => m.exposurePct).filter((value): value is number => value !== null)),
    avgReturnToDrawdown: avg(metrics.map((m) => m.returnToDrawdown).filter((value): value is number => value !== null)),
  };
}

function grossProfit(trades: SimulatedTrade[]): number {
  return trades.filter((trade) => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0);
}

function grossLossAbs(trades: SimulatedTrade[]): number {
  return Math.abs(trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
}

function profitFactorFromTrades(trades: SimulatedTrade[]): number | null {
  const losses = grossLossAbs(trades);
  if (losses === 0) return null;
  return grossProfit(trades) / losses;
}

function sourceDisplayFor(regimeSource: RegimeValidationSource, persistedRegimes: PersistedRegimeContext[]): RegimeSourceDisplay {
  if (regimeSource === "ohlcv_proxy") return "ohlcv_fallback_labels";
  const hasDeterministicRows = persistedRegimes.some((row) =>
    row.regimeModelVersion?.includes("deterministic") === true ||
    (typeof row.rawResponse === "object" && row.rawResponse !== null &&
      "source" in row.rawResponse &&
      String((row.rawResponse as { source?: unknown }).source).includes("deterministic")),
  );
  return hasDeterministicRows ? "deterministic_proxy_research_snapshots" : "gpt_a6_detector_snapshots";
}

function sourceDisplayLabel(source: RegimeSourceDisplay): string {
  switch (source) {
    case "gpt_a6_detector_snapshots":
      return "GPT/A6 detector snapshots";
    case "deterministic_proxy_research_snapshots":
      return "deterministic proxy research snapshots";
    case "ohlcv_fallback_labels":
      return "OHLCV fallback labels";
  }
}

function sourceCaution(source: RegimeSourceDisplay): string | null {
  if (source === "gpt_a6_detector_snapshots") return null;
  if (source === "deterministic_proxy_research_snapshots") {
    return "Note: persisted regimes are deterministic proxy research snapshots, not GPT/A6 detector outputs.";
  }
  return "Note: no persisted regime snapshots were available, so this run used in-memory OHLCV fallback labels.";
}

function routerMetricAudit(base: BacktestInput, windows: RegimeCandidateWindow[]): RouterMetricAudit {
  const results = windows.map((window) => ({
    window,
    result: runBacktest({
      ...sliceInput(base, window, DEFAULT_A6_REGIME_ROUTER_CONFIG.id),
      strategyRouter: defaultA6RegimeRouter,
    }),
  }));
  const allTrades = results.flatMap(({ result }) => result.trades);
  const rows = results.map(({ window, result }) => {
    const profit = grossProfit(result.trades);
    const lossAbs = grossLossAbs(result.trades);
    const selectedStrategies = [...new Set(result.trades.map((trade) => trade.strategyId))].sort().join(", ");
    return {
      regime: window.regime,
      startTs: window.startTs,
      endTs: window.endTs,
      tradeCount: result.trades.length,
      selectedStrategies: selectedStrategies || "none",
      returnPct: result.metrics.totalReturnPct,
      maxDrawdownPct: result.metrics.maxDrawdownPct,
      profitFactor: result.metrics.profitFactor,
      expectancy: result.metrics.expectancy,
      grossProfit: profit,
      grossLossAbs: lossAbs,
      exposurePct: result.metrics.exposurePct,
    };
  });
  const strategyCounts: Record<string, number> = {};
  for (const trade of allTrades) {
    strategyCounts[trade.strategyId] = (strategyCounts[trade.strategyId] ?? 0) + 1;
  }

  return {
    windows: results.length,
    noTradeWindows: results.filter(({ result }) => result.trades.length === 0).length,
    nonNullProfitFactorWindows: results.filter(({ result }) => result.metrics.profitFactor !== null).length,
    noLossProfitFactorWindows: results.filter(({ result }) => result.trades.length > 0 && grossLossAbs(result.trades) === 0).length,
    tinyLossProfitFactorWindows: results.filter(({ result }) => {
      const lossAbs = grossLossAbs(result.trades);
      return lossAbs > 0 && lossAbs < TINY_GROSS_LOSS_USD;
    }).length,
    reportedAverageProfitFactor: avg(results
      .map(({ result }) => result.metrics.profitFactor)
      .filter((value): value is number => value !== null)),
    globalProfitFactor: profitFactorFromTrades(allTrades),
    averageExpectancy: avg(results
      .map(({ result }) => result.metrics.expectancy)
      .filter((value): value is number => value !== null)),
    globalExpectancy: allTrades.length === 0 ? null : allTrades.reduce((sum, trade) => sum + trade.pnl, 0) / allTrades.length,
    averageReturnPct: avg(results.map(({ result }) => result.metrics.totalReturnPct)),
    totalReturnPct: base.config.initialCapital === 0
      ? null
      : allTrades.reduce((sum, trade) => sum + trade.pnl, 0) / base.config.initialCapital * 100,
    totalTrades: allTrades.length,
    selectedStrategyCounts: strategyCounts,
    rows,
  };
}

function routingSummaries(base: BacktestInput, windows: RegimeCandidateWindow[]): RoutingSummary[] {
  const strategyIds = STRATEGY_REGISTRY.map((strategy) => strategy.id);
  const summaries = strategyIds.map((strategyId) => {
    const metrics = windows.map((window) => runBacktest(sliceInput(base, window, strategyId)).metrics);
    return summarizeMetrics(strategyId, metrics);
  });
  const routedMetrics = windows.map((window) => runBacktest({
    ...sliceInput(base, window, DEFAULT_A6_REGIME_ROUTER_CONFIG.id),
    strategyRouter: defaultA6RegimeRouter,
  }).metrics);
  return [...summaries, summarizeMetrics(DEFAULT_A6_REGIME_ROUTER_CONFIG.id, routedMetrics)];
}

function portfolioSummaries(base: BacktestInput, windows: RegimeCandidateWindow[]): RoutingSummary[] {
  const strategyIds = STRATEGY_REGISTRY.map((strategy) => strategy.id);
  const equal: PortfolioBacktestConfig = { mode: "equal_weight", strategyIds };
  const custom: PortfolioBacktestConfig = {
    mode: "custom_weight",
    strategyIds,
    weights: Object.fromEntries(strategyIds.map((strategyId) => [strategyId, 0.25])),
  };
  const regime: PortfolioBacktestConfig = {
    mode: "regime_weight",
    strategyIds,
    regimeWeights: PORTFOLIO_REGIME_WEIGHTS,
  };
  return [equal, custom, regime].map((portfolioConfig) => {
    const metrics = windows.map((window) => runPortfolioBacktest(
      sliceInput(base, window, `portfolio_${portfolioConfig.mode}`),
      portfolioConfig,
    ).metrics);
    return summarizeMetrics(portfolioConfig.mode, metrics);
  });
}

function staticStrategyFullStats(base: BacktestInput, windows: RegimeCandidateWindow[]): FullStats[] {
  return STRATEGY_REGISTRY.map((strategy) => {
    const results = windows.map((window) => runBacktest(sliceInput(base, window, strategy.id)));
    const allTrades = results.flatMap((r) => r.trades);
    const metrics = results.map((r) => r.metrics);
    const returns = metrics.map((m) => m.totalReturnPct);
    const drawdowns = metrics.map((m) => m.maxDrawdownPct);
    const pfs = metrics.map((m) => m.profitFactor).filter((v): v is number => v !== null);
    const expectancies = metrics.map((m) => m.expectancy).filter((v): v is number => v !== null);
    const exposures = metrics.map((m) => m.exposurePct).filter((v): v is number => v !== null);
    const rtdds = metrics.map((m) => m.returnToDrawdown).filter((v): v is number => v !== null);
    const lossAbs = grossLossAbs(allTrades);
    return {
      label: strategy.id,
      samples: windows.length,
      avgReturn: avg(returns),
      medianReturn: medianOf(returns),
      maxDrawdown: drawdowns.length === 0 ? null : Math.max(...drawdowns),
      avgDrawdown: avg(drawdowns),
      globalProfitFactor: lossAbs === 0 ? null : grossProfit(allTrades) / lossAbs,
      avgProfitFactor: avg(pfs),
      globalExpectancy: allTrades.length === 0 ? null : allTrades.reduce((s, t) => s + t.pnl, 0) / allTrades.length,
      avgExpectancy: avg(expectancies),
      avgExposure: avg(exposures),
      tradeCount: allTrades.length,
      noTradeWindows: results.filter((r) => r.trades.length === 0).length,
      avgReturnToDrawdown: avg(rtdds),
    };
  });
}

function routerFullStatsFromAudit(audit: RouterMetricAudit, routerSummary: RoutingSummary): FullStats {
  const returns = audit.rows.map((r) => r.returnPct);
  const drawdowns = audit.rows.map((r) => r.maxDrawdownPct);
  const exposures = audit.rows.map((r) => r.exposurePct).filter((v): v is number => v !== null);
  return {
    label: DEFAULT_A6_REGIME_ROUTER_CONFIG.id,
    samples: audit.windows,
    avgReturn: audit.averageReturnPct,
    medianReturn: medianOf(returns),
    maxDrawdown: drawdowns.length === 0 ? null : Math.max(...drawdowns),
    avgDrawdown: avg(drawdowns),
    globalProfitFactor: audit.globalProfitFactor,
    avgProfitFactor: audit.reportedAverageProfitFactor,
    globalExpectancy: audit.globalExpectancy,
    avgExpectancy: audit.averageExpectancy,
    avgExposure: avg(exposures),
    tradeCount: audit.totalTrades,
    noTradeWindows: audit.noTradeWindows,
    avgReturnToDrawdown: routerSummary.avgReturnToDrawdown,
  };
}

function portfolioComparisonStats(base: BacktestInput, windows: RegimeCandidateWindow[]): FullStats[] {
  const strategyIds = STRATEGY_REGISTRY.map((strategy) => strategy.id);
  const configs: PortfolioBacktestConfig[] = [
    { mode: "equal_weight", strategyIds },
    { mode: "regime_weight", strategyIds, regimeWeights: PORTFOLIO_REGIME_WEIGHTS },
  ];
  return configs.map((config) => {
    const results = windows.map((window) => runPortfolioBacktest(
      sliceInput(base, window, `portfolio_${config.mode}`),
      config,
    ));
    const allTrades = results.flatMap((r) => r.trades);
    const metrics = results.map((r) => r.metrics);
    const returns = metrics.map((m) => m.totalReturnPct);
    const drawdowns = metrics.map((m) => m.maxDrawdownPct);
    const pfs = metrics.map((m) => m.profitFactor).filter((v): v is number => v !== null);
    const expectancies = metrics.map((m) => m.expectancy).filter((v): v is number => v !== null);
    const exposures = metrics.map((m) => m.exposurePct).filter((v): v is number => v !== null);
    const rtdds = metrics.map((m) => m.returnToDrawdown).filter((v): v is number => v !== null);
    const lossAbs = grossLossAbs(allTrades);
    return {
      label: config.mode,
      samples: windows.length,
      avgReturn: avg(returns),
      medianReturn: medianOf(returns),
      maxDrawdown: drawdowns.length === 0 ? null : Math.max(...drawdowns),
      avgDrawdown: avg(drawdowns),
      globalProfitFactor: lossAbs === 0 ? null : grossProfit(allTrades) / lossAbs,
      avgProfitFactor: avg(pfs),
      globalExpectancy: allTrades.length === 0 ? null : allTrades.reduce((s, t) => s + t.pnl, 0) / allTrades.length,
      avgExpectancy: avg(expectancies),
      avgExposure: avg(exposures),
      tradeCount: allTrades.length,
      noTradeWindows: results.filter((r) => r.trades.length === 0).length,
      avgReturnToDrawdown: avg(rtdds),
    };
  });
}

function routerBeatsAll(routerFull: FullStats, staticFull: FullStats[], portfolioFull: FullStats[]): boolean {
  const bestByReturn = [...staticFull].sort((a, b) => (b.avgReturn ?? Number.NEGATIVE_INFINITY) - (a.avgReturn ?? Number.NEGATIVE_INFINITY))[0];
  const bestByRtDD = [...staticFull].sort((a, b) => (b.avgReturnToDrawdown ?? Number.NEGATIVE_INFINITY) - (a.avgReturnToDrawdown ?? Number.NEGATIVE_INFINITY))[0];
  const equalWeight = portfolioFull.find((p) => p.label === "equal_weight");
  const regimeWeight = portfolioFull.find((p) => p.label === "regime_weight");
  const routerReturn = routerFull.avgReturn ?? Number.NEGATIVE_INFINITY;
  const routerRtDD = routerFull.avgReturnToDrawdown ?? Number.NEGATIVE_INFINITY;
  return (
    routerReturn > (bestByReturn?.avgReturn ?? Number.NEGATIVE_INFINITY) &&
    routerRtDD > (bestByRtDD?.avgReturnToDrawdown ?? Number.NEGATIVE_INFINITY) &&
    routerReturn > (equalWeight?.avgReturn ?? Number.NEGATIVE_INFINITY) &&
    routerReturn > (regimeWeight?.avgReturn ?? Number.NEGATIVE_INFINITY)
  );
}

function runConfigSummary(
  baseInput: BacktestInput,
  baseOptions: Omit<RegimeValidationOptions, "windowBars" | "minDominantRegimePct">,
  config: RunConfig,
): ConfigRunResult {
  const validation = runRegimeValidation({
    ...baseOptions,
    windowBars: config.windowBars,
    minDominantRegimePct: config.minDominantRegimePct,
  });
  const { selectedWindows } = validation;
  const staticFull = staticStrategyFullStats(baseInput, selectedWindows);
  const audit = routerMetricAudit(baseInput, selectedWindows);
  const rtdds = audit.rows
    .map((r) => r.maxDrawdownPct === 0 ? null : r.returnPct / r.maxDrawdownPct)
    .filter((v): v is number => v !== null);
  const syntheticEntry: RoutingSummary = {
    label: DEFAULT_A6_REGIME_ROUTER_CONFIG.id,
    samples: audit.windows,
    avgReturn: audit.averageReturnPct,
    avgDrawdown: avg(audit.rows.map((r) => r.maxDrawdownPct)),
    avgProfitFactor: audit.reportedAverageProfitFactor,
    avgExpectancy: audit.averageExpectancy,
    avgTrades: avg(audit.rows.map((r) => r.tradeCount)),
    avgExposure: avg(audit.rows.map((r) => r.exposurePct).filter((v): v is number => v !== null)),
    avgReturnToDrawdown: avg(rtdds),
  };
  const routerFull = routerFullStatsFromAudit(audit, syntheticEntry);
  const portfolioFull = portfolioComparisonStats(baseInput, selectedWindows);
  const purity = computeRegimePurity(selectedWindows);
  const windowsByRegime = Object.fromEntries(
    REQUIRED_REGIMES.map((r) => [r, selectedWindows.filter((w) => w.regime === r).length]),
  ) as Record<RegimeLabel, number>;
  return { config, validation, totalWindows: selectedWindows.length, windowsByRegime, purity, staticFull, routerFull, routerAudit: audit, portfolioFull };
}

function computeRegimePurity(selectedWindows: RegimeCandidateWindow[]): RegimePurityStats {
  const all = selectedWindows.map((w) => w.dominantRegimePct);
  const perRegime: RegimePurityStats["perRegime"] = {};
  for (const regime of REQUIRED_REGIMES) {
    const values = selectedWindows.filter((w) => w.regime === regime).map((w) => w.dominantRegimePct);
    perRegime[regime] = {
      samples: values.length,
      min: values.length === 0 ? null : Math.min(...values),
      median: medianOf(values),
      avg: avg(values),
    };
  }
  return {
    minDominantRegimePct: all.length === 0 ? null : Math.min(...all),
    medianDominantRegimePct: medianOf(all),
    avgDominantRegimePct: avg(all),
    perRegime,
  };
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" |")} |`,
    `| ${headers.map(() => "---").join(" |")} |`,
    ...rows.map((row) => `| ${row.join(" |")} |`),
  ].join("\n");
}

function aggregateTable(aggregates: AggregatedRegimeMetrics[]): string {
  return table(
    ["regime", "strategy", "samples", "avgReturn", "medReturn", "avgDD", "avgExpectancy", "avgPF", "avgWinRate", "avgExposure", "avgTrades", "ret/DD"],
    aggregates.map((row) => [
      row.regime,
      row.strategyId,
      String(row.samples),
      fmt(row.averageReturn),
      fmt(row.medianReturn),
      fmt(row.averageDrawdown),
      fmt(row.averageExpectancy, 4),
      fmt(row.averageProfitFactor),
      fmt(row.averageWinRate),
      fmt(row.averageExposure),
      fmt(row.averageTradeCount),
      fmt(row.returnToDrawdown),
    ]),
  );
}

function rankValue(
  row: AggregatedRegimeMetrics,
  rows: AggregatedRegimeMetrics[],
  pick: (value: AggregatedRegimeMetrics) => number | null,
  direction: "high" | "low",
): number {
  const sorted = rows
    .map((value) => ({ value, metric: pick(value) }))
    .filter((value): value is { value: AggregatedRegimeMetrics; metric: number } => value.metric !== null && Number.isFinite(value.metric))
    .sort((a, b) => direction === "high" ? b.metric - a.metric : a.metric - b.metric);
  const index = sorted.findIndex((value) => value.value.strategyId === row.strategyId);
  return index === -1 ? rows.length + 1 : index + 1;
}

function bestStrategyByRegimeTable(aggregates: AggregatedRegimeMetrics[]): string {
  const rows: string[][] = [];
  for (const regime of REQUIRED_REGIMES) {
    const regimeRows = aggregates.filter((row) => row.regime === regime && row.samples > 0);
    const ranked = regimeRows
      .map((row) => {
        const ranks = [
          rankValue(row, regimeRows, (value) => value.averageReturn, "high"),
          rankValue(row, regimeRows, (value) => value.medianReturn, "high"),
          rankValue(row, regimeRows, (value) => value.maxDrawdown, "low"),
          rankValue(row, regimeRows, (value) => value.averageExpectancy, "high"),
          rankValue(row, regimeRows, (value) => value.averageProfitFactor, "high"),
          rankValue(row, regimeRows, (value) => value.averageWinRate, "high"),
          rankValue(row, regimeRows, (value) => value.averageExposure, "low"),
          rankValue(row, regimeRows, (value) => value.returnToDrawdown, "high"),
        ];
        return {
          row,
          compositeRank: ranks.reduce((sum, value) => sum + value, 0) / ranks.length,
        };
      })
      .sort((a, b) =>
        a.compositeRank - b.compositeRank ||
        (b.row.averageReturn ?? Number.NEGATIVE_INFINITY) - (a.row.averageReturn ?? Number.NEGATIVE_INFINITY),
      );
    ranked.forEach((entry, index) => {
      rows.push([
        regime,
        String(index + 1),
        entry.row.strategyId,
        fmt(entry.compositeRank),
        String(entry.row.samples),
        fmt(entry.row.averageReturn),
        fmt(entry.row.medianReturn),
        fmt(entry.row.maxDrawdown),
        fmt(entry.row.averageExpectancy, 4),
        fmt(entry.row.averageProfitFactor),
        fmt(entry.row.averageWinRate),
        fmt(entry.row.averageExposure),
        fmt(entry.row.returnToDrawdown),
      ]);
    });
    if (ranked.length === 0) {
      rows.push([regime, "n/a", "n/a", "n/a", "0", "n/a", "n/a", "n/a", "n/a", "n/a", "n/a", "n/a", "n/a"]);
    }
  }
  return table(
    ["regime", "rank", "strategy", "score", "samples", "avgReturn", "medReturn", "maxDD", "expectancy", "PF", "winRate", "exposure", "ret/DD"],
    rows,
  );
}

function summaryTable(rows: RoutingSummary[]): string {
  return table(
    ["label", "samples", "avgReturn", "avgDD", "avgPF", "avgExpectancy", "avgTrades", "avgExposure", "ret/DD"],
    rows.map((row) => [
      row.label,
      String(row.samples),
      fmt(row.avgReturn),
      fmt(row.avgDrawdown),
      fmt(row.avgProfitFactor),
      fmt(row.avgExpectancy, 4),
      fmt(row.avgTrades),
      fmt(row.avgExposure),
      fmt(row.avgReturnToDrawdown),
    ]),
  );
}

function routerMetricAuditSection(audit: RouterMetricAudit): string[] {
  const strategyCounts = Object.entries(audit.selectedStrategyCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([strategyId, count]) => `${strategyId}: ${count}`)
    .join(", ") || "none";
  return [
    "### Router Metric Audit",
    "",
    "Router profit factor in the summary is the arithmetic average of non-null per-window profit factors. Windows with no losing trades have `null` profit factor and are excluded from that average, so the global trade-level profit factor below is included as a cross-check.",
    "",
    table(
      ["windows", "noTrade", "pfWindows", "noLossPF", "tinyLossPF", "avgPF", "globalPF", "avgExpectancy", "globalExpectancy", "avgReturn", "totalTradeReturn", "trades", "selectedStrategies"],
      [[
        String(audit.windows),
        String(audit.noTradeWindows),
        String(audit.nonNullProfitFactorWindows),
        String(audit.noLossProfitFactorWindows),
        String(audit.tinyLossProfitFactorWindows),
        fmt(audit.reportedAverageProfitFactor),
        fmt(audit.globalProfitFactor),
        fmt(audit.averageExpectancy, 4),
        fmt(audit.globalExpectancy, 4),
        fmt(audit.averageReturnPct),
        fmt(audit.totalReturnPct),
        String(audit.totalTrades),
        strategyCounts,
      ]],
    ),
    "",
    table(
      ["regime", "start", "trades", "strategies", "return", "maxDD", "PF", "expectancy", "grossProfit", "grossLoss", "exposure"],
      audit.rows.map((row) => [
        row.regime,
        row.startTs.slice(0, 10),
        String(row.tradeCount),
        row.selectedStrategies,
        fmt(row.returnPct),
        fmt(row.maxDrawdownPct),
        fmt(row.profitFactor),
        fmt(row.expectancy, 4),
        fmt(row.grossProfit, 2),
        fmt(row.grossLossAbs, 2),
        fmt(row.exposurePct),
      ]),
    ),
  ];
}

function routerVsStaticSection(
  staticStats: FullStats[],
  routerStats: FullStats,
  portfolioStats: FullStats[],
): string[] {
  const sortedByReturn = [...staticStats].sort((a, b) => (b.avgReturn ?? Number.NEGATIVE_INFINITY) - (a.avgReturn ?? Number.NEGATIVE_INFINITY));
  const sortedByRtDD = [...staticStats].sort((a, b) => (b.avgReturnToDrawdown ?? Number.NEGATIVE_INFINITY) - (a.avgReturnToDrawdown ?? Number.NEGATIVE_INFINITY));
  const bestByReturn = sortedByReturn[0];
  const bestByRtDD = sortedByRtDD[0];
  const equalWeight = portfolioStats.find((p) => p.label === "equal_weight");
  const regimeWeight = portfolioStats.find((p) => p.label === "regime_weight");

  const contestants: Array<[string, FullStats | undefined]> = [
    [DEFAULT_A6_REGIME_ROUTER_CONFIG.id, routerStats],
    [`${bestByReturn?.label ?? "n/a"} (best avg return)`, bestByReturn],
    [`${bestByRtDD?.label ?? "n/a"} (best ret/DD)`, bestByRtDD],
    ["equal_weight", equalWeight],
    ["regime_weight", regimeWeight],
  ];

  const rows: string[][] = [
    ["avg return (%)", ...contestants.map(([, s]) => fmt(s?.avgReturn))],
    ["median return (%)", ...contestants.map(([, s]) => fmt(s?.medianReturn))],
    ["max drawdown (%)", ...contestants.map(([, s]) => fmt(s?.maxDrawdown))],
    ["avg drawdown (%)", ...contestants.map(([, s]) => fmt(s?.avgDrawdown))],
    ["global PF", ...contestants.map(([, s]) => fmt(s?.globalProfitFactor))],
    ["avg PF", ...contestants.map(([, s]) => fmt(s?.avgProfitFactor))],
    ["global expectancy ($)", ...contestants.map(([, s]) => fmt(s?.globalExpectancy, 4))],
    ["avg expectancy ($)", ...contestants.map(([, s]) => fmt(s?.avgExpectancy, 4))],
    ["exposure (%)", ...contestants.map(([, s]) => fmt(s?.avgExposure))],
    ["trade count", ...contestants.map(([, s]) => String(s?.tradeCount ?? "n/a"))],
    ["no-trade windows", ...contestants.map(([, s]) => String(s?.noTradeWindows ?? "n/a"))],
    ["ret/DD", ...contestants.map(([, s]) => fmt(s?.avgReturnToDrawdown))],
  ];

  const beats = routerBeatsAll(routerStats, staticStats, portfolioStats);
  const verdict = beats
    ? "Router verdict: **VALIDATED** — router beats best static by avg return, best static by ret/DD, equal-weight, and regime-weight."
    : "Router verdict: **NOT VALIDATED** — router does not beat all four benchmarks (best static by avg return, best static by ret/DD, equal-weight, regime-weight). Do not claim A6 routing outperforms until all four are exceeded.";

  return [
    "### Router vs Best Static Strategy Comparison",
    "",
    "All contestants evaluated across the same non-overlapping regime windows. ret/DD is the average of per-window (totalReturnPct / maxDrawdownPct) ratios; windows with zero drawdown are excluded from that average. Global profit factor and global expectancy aggregate all trades across all windows combined.",
    "",
    table(
      ["metric", ...contestants.map(([label]) => label)],
      rows,
    ),
    "",
    `Best static by avg return: **${bestByReturn?.label ?? "n/a"}** (${fmt(bestByReturn?.avgReturn)}%)`,
    `Best static by ret/DD: **${bestByRtDD?.label ?? "n/a"}** (ret/DD = ${fmt(bestByRtDD?.avgReturnToDrawdown)})`,
    "",
    verdict,
    "",
  ];
}

function regimePuritySection(selectedWindows: RegimeCandidateWindow[], minDominantRegimePct: number): string[] {
  const purity = computeRegimePurity(selectedWindows);
  return [
    "### Regime-Window Purity Diagnostics",
    "",
    "dominantRegimePct is the share of bars in a window labeled with the window's dominant regime. All selected windows pass the configured minimum threshold.",
    "",
    table(
      ["stat", "value"],
      [
        ["selection threshold (%)", String(minDominantRegimePct)],
        ["min dominantRegimePct (%)", fmt(purity.minDominantRegimePct)],
        ["median dominantRegimePct (%)", fmt(purity.medianDominantRegimePct)],
        ["avg dominantRegimePct (%)", fmt(purity.avgDominantRegimePct)],
      ],
    ),
    "",
    "Per-regime purity summary:",
    "",
    table(
      ["regime", "samples", "min (%)", "median (%)", "avg (%)"],
      REQUIRED_REGIMES.map((regime) => {
        const s = purity.perRegime[regime];
        return [regime, String(s?.samples ?? 0), fmt(s?.min), fmt(s?.median), fmt(s?.avg)];
      }),
    ),
    "",
  ];
}

function validationConfigComparisonSection(results: ConfigRunResult[], primaryLabel: string): string[] {
  const rows = results.map((result) => {
    const { config, totalWindows, windowsByRegime, purity, staticFull, routerFull, portfolioFull } = result;
    const bestByReturn = [...staticFull].sort((a, b) => (b.avgReturn ?? Number.NEGATIVE_INFINITY) - (a.avgReturn ?? Number.NEGATIVE_INFINITY))[0];
    const bestByRtDD = [...staticFull].sort((a, b) => (b.avgReturnToDrawdown ?? Number.NEGATIVE_INFINITY) - (a.avgReturnToDrawdown ?? Number.NEGATIVE_INFINITY))[0];
    const beats = routerBeatsAll(routerFull, staticFull, portfolioFull);
    const delta = routerFull.avgReturn !== null && bestByReturn?.avgReturn !== null
      ? routerFull.avgReturn - bestByReturn.avgReturn
      : null;
    return [
      config.label + (config.label === primaryLabel ? " ★" : ""),
      String(totalWindows),
      REQUIRED_REGIMES.map((r) => String(windowsByRegime[r])).join("/"),
      fmt(purity.minDominantRegimePct),
      fmt(purity.medianDominantRegimePct),
      fmt(purity.avgDominantRegimePct),
      bestByReturn?.label ?? "n/a",
      bestByRtDD?.label ?? "n/a",
      fmt(routerFull.avgReturn),
      fmt(routerFull.globalProfitFactor),
      fmt(routerFull.globalExpectancy, 4),
      fmt(delta),
      String(routerFull.noTradeWindows),
      String(routerFull.tradeCount),
      beats ? "YES" : "NO",
    ];
  });
  return [
    "### Validation Configuration Comparison",
    "",
    "Side-by-side results across windowBars ∈ {144, 336} and minDominantRegimePct ∈ {50%, 65%}. ★ marks the primary config (most selected windows; tie-breaks: lower purity threshold, then smaller window). Regime column order: TU/TD/HV/LV/NS/CH. Router verdict is YES only if the router simultaneously beats best-static-by-avg-return, best-static-by-ret/DD, equal-weight, and regime-weight.",
    "",
    table(
      ["config", "total windows", "windows TU/TD/HV/LV/NS/CH", "min purity%", "med purity%", "avg purity%", "best static (ret)", "best static (rtDD)", "router avg ret%", "router gPF", "router gExpect", "delta vs best ret%", "noTrade", "trades", "verdict"],
      rows,
    ),
    "",
  ];
}

function featureAlignedBars(bars: Bar[], features: FeatureSnapshot[]): Bar[] {
  if (features.length === 0) return [];
  const featureTs = new Set(features.map((feature) => feature.ts));
  return bars.filter((bar) => featureTs.has(bar.ts));
}

function coverageCounts(windows: RegimeCandidateWindow[]): Record<RegimeLabel, number> {
  return Object.fromEntries(
    REQUIRED_REGIMES.map((regime) => [regime, windows.filter((window) => window.regime === regime).length]),
  ) as Record<RegimeLabel, number>;
}

function averageTradeCountPerWindow(aggregates: AggregatedRegimeMetrics[]): number | null {
  return avg(aggregates
    .map((row) => row.averageTradeCount)
    .filter((value): value is number => value !== null));
}

function validationWarnings(context: ValidationWarningContext): string[] {
  const warnings: string[] = [];
  const counts = coverageCounts(context.selectedWindows);
  const insufficient = REQUIRED_REGIMES
    .filter((regime) => counts[regime] < context.requestedWindowsPerRegime)
    .map((regime) => `${regime}: ${counts[regime]}/${context.requestedWindowsPerRegime}`);
  const avgTrades = averageTradeCountPerWindow(context.aggregates);

  if (avgTrades !== null && avgTrades < NEAR_ZERO_TRADES_PER_WINDOW) {
    warnings.push(
      `Average trades per window is near zero (${fmt(avgTrades, 3)}). Treat return and expectancy comparisons as low-signal.`,
    );
  }
  if (context.effectiveWindowBars < MIN_PROXY_WINDOW_BARS) {
    warnings.push(
      `Window size is below the minimum meaningful proxy threshold (${context.effectiveWindowBars} < ${MIN_PROXY_WINDOW_BARS}).`,
    );
  }
  if (context.clampedWindowBars) {
    warnings.push(
      `Configured proxy window size (${context.configuredWindowBars}) was below ${MIN_PROXY_WINDOW_BARS}; validation used ${context.effectiveWindowBars} bars instead.`,
    );
  }
  if (insufficient.length > 0) {
    warnings.push(
      `Insufficient ${context.regimeSource === "ohlcv_proxy" ? "proxy" : "persisted snapshot"} coverage with meaningful windows; selected fewer than requested windows for ${insufficient.join(", ")}.`,
    );
  }

  return warnings;
}

async function runInstrument(instrument: InstrumentArg): Promise<string> {
  const timeframe: Timeframe = "1h";
  const bounds = process.env.START_TS && process.env.END_TS
    ? { startTs: process.env.START_TS, endTs: process.env.END_TS }
    : await fetchBounds(instrument.symbol, instrument.exchange, timeframe);
  if (!bounds) return `## ${instrument.symbol}\n\nNo stored ${timeframe} bars found.\n`;

  const pool = getPgPool();
  const barStore = new PgBarStore(pool);
  const featureStore = new PgFeatureStore(pool);
  const [bars, features, dailyFeatures, persistedRegimes] = await Promise.all([
    barStore.fetchRange({ ...instrument, timeframe }, { startTs: bounds.startTs, endTs: bounds.endTs }),
    featureStore.fetchRange({ ...instrument, timeframe, featureVersion: FEATURE_VERSION }, bounds),
    featureStore.fetchRange({ ...instrument, timeframe: "1d", featureVersion: FEATURE_VERSION }, bounds),
    fetchRegimes(instrument.symbol, instrument.exchange, bounds.startTs, bounds.endTs),
  ]);

  const executableBars = featureAlignedBars(bars, features);
  const regimeSource: RegimeValidationSource = persistedRegimes.length > 0 ? "a6_snapshots" : "ohlcv_proxy";
  const regimes = regimeSource === "a6_snapshots"
    ? persistedRegimes
    : buildOhlcvProxyRegimes(executableBars, features);
  const regimeSourceDisplay = sourceDisplayFor(regimeSource, persistedRegimes);
  const config = baseConfig(instrument, bounds.startTs, bounds.endTs);
  const baseInput: BacktestInput = { config, bars: executableBars, features, dailyFeatures, regimes };
  const {
    symbol: _symbol,
    exchange: _exchange,
    strategyId: _strategyId,
    startTs: _startTs,
    endTs: _endTs,
    ...validationBaseConfig
  } = config;
  const requestedWindowsPerRegime = Number(process.env.WINDOWS_PER_REGIME ?? 10);
  const validationBaseOptions: Omit<RegimeValidationOptions, "windowBars" | "minDominantRegimePct"> = {
    instrument,
    baseConfig: validationBaseConfig,
    bars: executableBars,
    features,
    dailyFeatures,
    regimes,
    regimeSource,
    windowsPerRegime: requestedWindowsPerRegime,
  };

  const configResults = RUN_CONFIGS.map((config) => runConfigSummary(baseInput, validationBaseOptions, config));
  const primaryResult = configResults.reduce((best, current) => {
    if (current.totalWindows !== best.totalWindows) return current.totalWindows > best.totalWindows ? current : best;
    if (current.config.minDominantRegimePct !== best.config.minDominantRegimePct)
      return current.config.minDominantRegimePct < best.config.minDominantRegimePct ? current : best;
    return current.config.windowBars < best.config.windowBars ? current : best;
  });

  const { validation } = primaryResult;
  const minPurityPct = primaryResult.config.minDominantRegimePct;
  const effectiveWindowBars = primaryResult.config.windowBars;

  const routing = routingSummaries(baseInput, validation.selectedWindows);
  const routerAudit = primaryResult.routerAudit;
  const portfolios = portfolioSummaries(baseInput, validation.selectedWindows);
  const staticFull = primaryResult.staticFull;
  const routerEntry = routing.find((r) => r.label === DEFAULT_A6_REGIME_ROUTER_CONFIG.id) ?? routing[routing.length - 1];
  const routerFull = routerFullStatsFromAudit(routerAudit, routerEntry);
  const portfolioFull = primaryResult.portfolioFull;
  const warnings = validationWarnings({
    requestedWindowsPerRegime,
    configuredWindowBars: effectiveWindowBars,
    effectiveWindowBars,
    selectedWindows: validation.selectedWindows,
    aggregates: validation.aggregates,
    regimeSource,
    clampedWindowBars: false,
  });
  const coverage = REQUIRED_REGIMES
    .map((regime) => `${regime}: ${validation.selectedWindows.filter((window) => window.regime === regime).length}`)
    .join(", ");

  return [
    `## ${instrument.symbol}`,
    "",
    `Instrument: symbol=${instrument.symbol}, exchange=${instrument.exchange}, assetType=${instrument.assetType}, dataSource=${instrument.dataSource}`,
    `Range: ${bounds.startTs} to ${bounds.endTs}`,
    `Rows: bars=${bars.length}, executableBars=${executableBars.length}, features=${features.length}, dailyFeatures=${dailyFeatures.length}, persistedRegimes=${persistedRegimes.length}, researchRegimes=${regimes.length}`,
    `Regime source: ${sourceDisplayLabel(regimeSourceDisplay)}`,
    `Window bars: ${validation.selectedWindows[0]?.barCount ?? effectiveWindowBars} (primary config: ${primaryResult.config.label})`,
    `Requested windows per regime: ${requestedWindowsPerRegime}`,
    `Selected windows: ${validation.selectedWindows.length} (${coverage})`,
    sourceCaution(regimeSourceDisplay) ?? "",
    warnings.length > 0 ? "" : "",
    warnings.length > 0 ? "### Validation Warnings" : "",
    ...warnings.map((warning) => `- ${warning}`),
    "",
    "### Multi-Window Results",
    aggregateTable(validation.aggregates),
    "",
    "### Best Strategy By Regime",
    "",
    "Composite score is the average ordinal rank across avg return, median return, max drawdown, expectancy, profit factor, win rate, exposure, and return-to-drawdown. Lower score is better; drawdown and exposure are ranked low-to-high.",
    "",
    bestStrategyByRegimeTable(validation.aggregates),
    "",
    "### A6 Routing Results",
    summaryTable(routing),
    "",
    ...routerMetricAuditSection(routerAudit),
    "",
    "### Portfolio Results",
    summaryTable(portfolios),
    "",
    ...routerVsStaticSection(staticFull, routerFull, portfolioFull),
    ...regimePuritySection(validation.selectedWindows, minPurityPct),
    ...validationConfigComparisonSection(configResults, primaryResult.config.label),
    "### Stability Rankings",
    table(
      ["regime", "strategy", "samples", "score", "returnStd", "drawdownStd", "profitFactorStd", "expectancyStd"],
      validation.stabilityRankings.map((row) => [
        row.regime,
        row.strategyId,
        String(row.samples),
        fmt(row.score),
        fmt(row.returnConsistency),
        fmt(row.drawdownConsistency),
        fmt(row.profitFactorStability),
        fmt(row.expectancyStability),
      ]),
    ),
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const sections: string[] = [];
  const instruments = parseInstruments();
  for (const instrument of instruments) {
    sections.push(await runInstrument(instrument));
  }

  const report = [
    "# P4 Expanded Strategy Analytics And Routing Report",
    "",
    "Generated by `scripts/runExpandedBacktestResearch.ts`.",
    "",
    "## Implementation Summary",
    "",
    "- Expanded P4 metrics with expectancy, win/loss averages, streaks, exposure, duration, Sharpe/Sortino aliases, profit per bar, return-to-drawdown, and trade frequency.",
    "- Added configurable A6 regime routing via `lib/backtest/strategyRouter.ts`; the engine accepts a router but does not hardcode mappings.",
    "- Added portfolio research composition via `lib/backtest/portfolioBacktest.ts` with equal, custom, and regime-weighted allocations.",
    "- Added multi-window regime validation via `lib/backtest/regimeValidation.ts` with non-overlapping regime windows and stability rankings.",
    "- Tuned deterministic proxy regime classification toward 144-bar research windows, including shock clusters, high-volatility clusters, and range-bound CHOP behavior.",
    "- Added OHLCV proxy regime fallback for TREND_UP, TREND_DOWN, HIGH_VOL, LOW_VOL, NEWS_SHOCK, and CHOP when persisted A6 snapshots are unavailable.",
    "- Report regime source labels now distinguish GPT/A6 detector snapshots, deterministic proxy research snapshots, and OHLCV fallback labels.",
    "- Added a Router Metric Audit section to cross-check average profit factor, global profit factor, no-trade windows, and per-window routed trades.",
    "- Added a Best Strategy By Regime leaderboard using multi-metric ordinal ranks.",
    "- Proxy validation uses meaningful windows by default: 144 bars preferred and 72 bars minimum. Coverage is reported honestly when fewer than the requested windows are available.",
    "- Kept persistence schema unchanged because run metrics are stored as JSONB.",
    "- Added Router vs Best Static Strategy comparison with median return, max drawdown, global profit factor, global expectancy, trade count, and no-trade windows. Router verdict is VALIDATED only if it beats best-static-by-avg-return, best-static-by-ret/DD, equal-weight, and regime-weight simultaneously.",
    "- Added regime-window purity diagnostics reporting min, median, and avg dominantRegimePct overall and per regime.",
    "- Added Validation Configuration Comparison: side-by-side runs across windowBars ∈ {144, 336} × minDominantRegimePct ∈ {50%, 65%}. Primary config (most windows) drives the detailed sections; all four configs appear in the comparison table.",
    "",
    "## Strategy Analytics",
    "",
    "New metrics now emitted by `BacktestMetrics`: `expectancy`, `avgWin`, `avgLoss`, `maxWinningStreak`, `maxLosingStreak`, `exposurePct`, `avgTradeDurationBars`, `avgTradeDurationMs`, `medianTradeDurationBars`, `medianTradeDurationMs`, `sharpeRatio`, `sortinoRatio`, `profitPerBar`, `returnToDrawdown`, and `tradeFrequency`.",
    "",
    "Backward-compatible P4 names remain in place: `averageWinner`, `averageLoser`, `expectancyPerTrade`, `sharpeApprox`, `sortinoApprox`, `exposureTimePct`, `averageHoldHours`, and `maxConsecutiveLosses`.",
    "",
    "Validation coverage added in `_smoke/backtest.ts`: zero trades, one trade, all winners, all losers, mixed outcomes, A6 routed research runs, and portfolio allocation safety.",
    "",
    "## Architecture Changes",
    "",
    "- A6 routing is configuration-driven through `createRegimeStrategyRouter`; the engine receives a router interface and does not know the regime map.",
    "- Regime validation prefers persisted snapshots, but the report labels whether those rows came from the GPT/A6 detector or deterministic proxy research generation. If none exist, it builds in-memory OHLCV fallback labels.",
    "- `regime -> []` and missing regime mappings produce no trade, allowing future capital-preservation experiments.",
    "- Portfolio research validates `sum(weights) <= 100%` and rejects implicit leverage.",
    "- Validation tooling accepts `symbol`, `exchange`, `assetType`, and `dataSource` for multi-asset expansion.",
    "- PORTFOLIO_REGIME_WEIGHTS extracted as a module-level constant shared by portfolio summaries and comparison stats.",
    "",
    "## Issues Found",
    "",
    "- Deterministic proxy research snapshots and OHLCV fallback labels are not described as GPT/A6 detector validation.",
    "- BTC-USD data coverage is reported per run as bars, executable bars, 1h features, daily features, and persisted regimes. If any coverage falls short, the report keeps sample counts lower rather than manufacturing windows.",
    "- If meaningful proxy windows cannot provide the requested windows per regime, the report intentionally keeps lower sample counts rather than shrinking to 1-2 bar windows.",
    "- Current portfolio research uses scaled simulated trade PnL and should not be treated as a full broker-grade portfolio accounting engine.",
    "",
    "## Limitations",
    "",
    "- This remains research only. No live, broker, paper trading, order manager, or capital deployment path is introduced.",
    "- Portfolio equity realizes scaled trade PnL at exits and does not model intra-trade capital contention.",
    "- Strategy simulations preserve the current long-only/default P4 assumptions unless explicitly configured otherwise.",
    "- Statistical confidence depends on available persisted bars, features, and A6 regime snapshots. Proxy mode improves coverage but is not a substitute for persisted A6 labels.",
    "- staticStrategyFullStats and portfolioComparisonStats re-run backtests independently of routingSummaries and portfolioSummaries; this is intentional to keep the comparison section isolated but doubles computation.",
    "",
    ...sections,
    "## Recommendations",
    "",
    "1. Prefer decisions based on stability rankings and expectancy, not isolated total-return winners.",
    "2. Increase each regime to 20 non-overlapping windows per asset before drawing production conclusions.",
    "3. Add ETH-USD and SOL-USD once feature/regime coverage matches BTC-USD.",
    "4. Revisit portfolio drawdown modeling if research suggests regime allocation is promising.",
    "",
  ].join("\n");

  const reportPath = path.join(process.cwd(), "P4_EXPANDED_STRATEGY_ANALYTICS_AND_ROUTING_REPORT.md");
  fs.writeFileSync(reportPath, report);
  console.log(`wrote ${reportPath}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePgPool().catch(() => undefined);
  });
