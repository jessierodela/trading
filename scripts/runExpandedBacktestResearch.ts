import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { getPgPool, PgBarStore, PgFeatureStore } from "@/lib/storage";
import { closePgPool } from "@/lib/storage/clients";
import { FEATURE_VERSION } from "@/lib/versions";
import type { Bar, Exchange, FeatureSnapshot, RegimeContext, RegimeLabel, Timeframe } from "@/lib/quant/types";
import { GATE_EVALUATORS } from "@/lib/strategies/refinement/gates";
import {
  REFINED_STRATEGY_CONFIGS,
  REFINED_STRATEGY_PAIRS,
  REFINED_STRATEGY_RULE_SUMMARIES,
} from "@/lib/strategies/refinement/strategyVariants";
import { STRATEGY_REGISTRY } from "@/lib/strategies/strategyRegistry";
import type { StrategyGateId } from "@/lib/strategies/refinement/types";
import { runBacktest as runBacktestRaw } from "@/lib/backtest/backtestEngine";
import { runPortfolioBacktest, type PortfolioBacktestConfig } from "@/lib/backtest/portfolioBacktest";
import {
  createRegimeStrategyRouter,
  DEFAULT_A6_REGIME_ROUTER_CONFIG,
  DEFAULT_A6_REGIME_STRATEGY_MAP,
  defaultA6RegimeRouter,
  type RegimeStrategyMap,
  type RegimeStrategyRouterConfig,
} from "@/lib/backtest/strategyRouter";
import {
  aggregateRegimeMetrics,
  buildOhlcvProxyRegimes,
  REQUIRED_REGIMES,
  runRegimeValidation,
  type AggregatedRegimeMetrics,
  type RegimeCandidateWindow,
  type RegimeValidationOptions,
  type RegimeValidationResult,
  type RegimeValidationSource,
  type RegimeWindowBacktest,
} from "@/lib/backtest/regimeValidation";
import type {
  BacktestAssetType,
  BacktestConfig,
  BacktestInput,
  BacktestMetrics,
  RiskOverlaySummary,
  SimulatedTrade,
} from "@/lib/backtest/types";

type BacktestRunResult = ReturnType<typeof runBacktestRaw>;

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
  losingTradeCount: number;
  stopLossExitCount: number;
  noTradeWindows: number;
  avgReturnToDrawdown: number | null;
}

interface RiskOverlayReportSummary {
  strategyId: string;
  windows: number;
  rawTradeCount: number;
  riskAdjustedTradeCount: number;
  blockedTrades: number;
  blockedByReason: Record<string, number>;
  rawMaxDrawdownPct: number | null;
  riskAdjustedMaxDrawdownPct: number | null;
  rawAvgReturnPct: number | null;
  riskAdjustedAvgReturnPct: number | null;
  rawAvgProfitFactor: number | null;
  riskAdjustedAvgProfitFactor: number | null;
  rawAvgExpectancy: number | null;
  riskAdjustedAvgExpectancy: number | null;
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
const CROSS_ASSET_OPPORTUNITY_TOP_N = 30;
const MIN_OPPORTUNITY_TEST_TRADES = 5;
const EQUITY_WATCHLIST_TARGETS: Array<{ symbol: string; assetType: BacktestAssetType; missingBarsReason: string }> = [
  { symbol: "SPY", assetType: "ETF", missingBarsReason: "no stored equity/ETF bars available" },
  { symbol: "QQQ", assetType: "ETF", missingBarsReason: "no stored equity/ETF bars available" },
  { symbol: "AAPL", assetType: "EQUITY", missingBarsReason: "no stored equity bars available" },
  { symbol: "MSFT", assetType: "EQUITY", missingBarsReason: "no stored equity bars available" },
  { symbol: "NVDA", assetType: "EQUITY", missingBarsReason: "no stored equity bars available" },
];
const DAY_MS = 24 * 60 * 60 * 1000;
const backtestResultCache = new Map<string, BacktestRunResult>();

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

type ResearchAssetType = "CRYPTO" | "EQUITY" | "ETF";

const ETF_SYMBOLS = new Set(["DIA", "IWM", "QQQ", "SPY", "VOO", "VTI"]);
const BASE_STRATEGY_IDS = new Set<string>(REFINED_STRATEGY_PAIRS.map((pair) => pair.baseStrategyId));
const REFINED_STRATEGY_IDS = new Set<string>(REFINED_STRATEGY_PAIRS.map((pair) => pair.refinedStrategyId));

export interface AssetReadinessDiagnostics {
  symbol: string;
  exchange: Exchange;
  assetType: ResearchAssetType;
  bars1h: number;
  features1h: number;
  featureCoverage1hPct: number | null;
  dailyBars: number;
  dailyFeatures: number;
  dailyFeatureCoveragePct: number | null;
  regimeLabels: number;
  regimeCoveragePct: number | null;
  isResearchReady: boolean;
  notReadyReason: string | null;
}

interface DiscoveryRow extends AssetReadinessDiagnostics {
  selectionReason: string | null;
}

interface DiscoveryFilters {
  minAssetBars: number;
  minFeatureCoveragePct: number;
  requireRegimeSnapshots: boolean;
  maxAssets: number | null;
  exchange: string | null;
}

interface DiscoveryResult {
  filters: DiscoveryFilters;
  candidates: DiscoveryRow[];
  selected: DiscoveryRow[];
  excluded: DiscoveryRow[];
}

interface InstrumentResolution {
  source: "explicit_symbols" | "dynamic_discovery" | "single_asset_default";
  instruments: InstrumentArg[];
  discovery: DiscoveryResult | null;
}

interface OpportunityCandidatePeriodStats {
  samples: number;
  avgReturn: number | null;
  globalProfitFactor: number | null;
  globalExpectancy: number | null;
  maxDrawdown: number | null;
  tradeCount: number;
}

interface OpportunityCandidateValidation {
  symbol: string;
  regime: RegimeLabel;
  strategyId: string;
  train: OpportunityCandidatePeriodStats;
  test: OpportunityCandidatePeriodStats;
  testPass: boolean;
}

interface OpportunityRollingFold {
  trainEnd: number;
  testEnd: number;
  candidates: OpportunityCandidateValidation[];
}

interface OpportunityWalkForwardData {
  trainWindows: RegimeCandidateWindow[];
  testWindows: RegimeCandidateWindow[];
  candidates: OpportunityCandidateValidation[];
  rollingFolds: OpportunityRollingFold[];
}

interface TradePoolStats {
  grossProfit: number;
  grossLossAbs: number;
  pooledProfitFactor: number | null;
  pooledExpectancy: number | null;
  tradeCount: number;
}

interface GateDiagnosticRow {
  strategyId: string;
  gate: StrategyGateId;
  passes: number;
  fails: number;
  unavailablePasses: number;
}

interface RefinementFoldCounts {
  validated: number;
  comparable: number;
  missingBase: number;
  missingRefined: number;
}

interface ReportRunMetadata {
  branch: string;
  generatedFromCommit: string;
  committedInCommit?: string | null;
  runTimestamp: string;
  reportPath: string;
  logPath?: string | null;
  strategyVersions: Record<string, string>;
  featureVersion: string;
  windowConfig: string;
  symbolsDiscovered: string[];
}

function parseSymbolList(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function inferAssetType(symbol: string): ResearchAssetType {
  const normalized = symbol.trim().toUpperCase();
  if (normalized.includes("-USD")) return "CRYPTO";
  if (ETF_SYMBOLS.has(normalized)) return "ETF";
  return "EQUITY";
}

function instrumentFor(symbol: string, exchange: Exchange, allowAssetTypeOverride = false): InstrumentArg {
  return {
    symbol,
    exchange,
    assetType: (allowAssetTypeOverride && process.env.ASSET_TYPE
      ? process.env.ASSET_TYPE
      : inferAssetType(symbol)) as BacktestAssetType,
    dataSource: process.env.DATA_SOURCE ?? "postgres",
  };
}

function explicitSymbols(): string[] | null {
  if (process.env.SYMBOLS === undefined) return null;
  const symbols = parseSymbolList(process.env.SYMBOLS);
  if (symbols.length === 0) {
    throw new Error("SYMBOLS was provided but no valid symbols were parsed. Use a comma-separated list such as SYMBOLS=BTC-USD,ETH-USD.");
  }
  return symbols;
}

function isMultiAssetRun(): boolean {
  const lifecycle = process.env.npm_lifecycle_event;
  return lifecycle === "research:p5:multiasset" ||
    process.env.P5_MULTI_ASSET === "1" ||
    process.env.P5_MULTI_ASSET === "true" ||
    process.env.MULTI_ASSET === "1" ||
    process.env.MULTI_ASSET === "true";
}

function envPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function envPositiveInteger(name: string, fallback: number): number {
  const parsed = envPositiveNumber(name, fallback);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function envPercentage(name: string, fallback: number): number {
  const parsed = envPositiveNumber(name, fallback);
  if (parsed > 100) throw new Error(`${name} must be greater than 0 and less than or equal to 100`);
  return parsed;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  throw new Error(`${name} must be true/false or 1/0`);
}

function researchRiskOverlayConfig(): BacktestConfig["risk"] | undefined {
  if (!envBoolean("P5_RISK_OVERLAY", false)) return undefined;
  return {
    enabled: true,
    config: {
      enabled: true,
      maxRiskPerTradePct: Number(process.env.RISK_PER_TRADE_PCT ?? 0.005),
      maxDailyLossPct: 0.02,
      maxWeeklyLossPct: 0.05,
      maxOpenPositions: 1,
      maxSymbolExposurePct: Number(process.env.MAX_POSITION_PCT ?? 1),
      maxPortfolioExposurePct: 1,
      minRegimeReliability: 0.5,
      blockedRegimes: [],
      allowLong: true,
      allowShort: false,
      allowDefaultStopFallback: false,
      defaultStopLossPct: 0.02,
      defaultTakeProfitPct: 0.04,
      maxLeverage: 1,
      staleSignalMaxAgeMs: 2 * 60 * 60 * 1000,
      duplicateCooldownMs: 0,
      maxConsecutiveLosses: 3,
      highVolSizeMultiplier: 0.5,
      chopSizeMultiplier: 0.25,
      newsShockBlocksTrading: true,
      killSwitchEnabled: false,
    },
  };
}

async function discoverStoredInstruments(): Promise<DiscoveryResult> {
  const pool = getPgPool();
  const exchangeFilter = process.env.EXCHANGE?.trim();
  const maxAssetsRaw = process.env.MAX_ASSETS;
  const minAssetBars = envPositiveInteger("MIN_ASSET_BARS", 1000);
  const minFeatureCoveragePct = envPercentage("MIN_FEATURE_COVERAGE_PCT", 95);
  const requireRegimeSnapshots = envBoolean("REQUIRE_REGIME_SNAPSHOTS", false);
  const maxAssets = maxAssetsRaw ? envPositiveInteger("MAX_ASSETS", 1) : null;

  const params: unknown[] = [FEATURE_VERSION];
  const exchangeClause = exchangeFilter ? "and b.exchange = $2" : "";
  if (exchangeFilter) params.push(exchangeFilter);

  const { rows } = await pool.query<{
    symbol: string;
    exchange: Exchange;
    bars_1h: string;
    features_1h: string;
    daily_bars: string;
    daily_features: string;
    regime_labels: string;
  }>(
    `with bar_counts as (
       select b.symbol, b.exchange, count(*)::text as bars_1h
       from market_bars b
       where b.timeframe = '1h'
         ${exchangeClause}
       group by b.symbol, b.exchange
     ),
     feature_counts as (
       select b.symbol, b.exchange, count(distinct b.ts)::text as features_1h
       from market_bars b
       join feature_snapshots f
         on f.symbol = b.symbol
        and f.exchange = b.exchange
        and f.timeframe = b.timeframe
        and f.ts = b.ts
        and f.feature_version = $1
       where b.timeframe = '1h'
         ${exchangeClause}
       group by b.symbol, b.exchange
     ),
     daily_bar_counts as (
       select b.symbol, b.exchange, count(*)::text as daily_bars
       from market_bars b
       where b.timeframe = '1d'
         ${exchangeClause}
       group by b.symbol, b.exchange
     ),
     daily_feature_counts as (
       select b.symbol, b.exchange, count(distinct b.ts)::text as daily_features
       from market_bars b
       join feature_snapshots f
         on f.symbol = b.symbol
        and f.exchange = b.exchange
        and f.timeframe = b.timeframe
        and f.ts = b.ts
        and f.feature_version = $1
       where b.timeframe = '1d'
         ${exchangeClause}
       group by b.symbol, b.exchange
     ),
     regime_counts as (
       select b.symbol, b.exchange, count(distinct b.ts)::text as regime_labels
       from market_bars b
       join regime_snapshots r
         on r.symbol = b.symbol
        and r.exchange = b.exchange
        and r.ts = b.ts
        and (r.feature_version is null or r.feature_version = $1)
       where b.timeframe = '1h'
         ${exchangeClause}
       group by b.symbol, b.exchange
     ),
     instrument_keys as (
       select symbol, exchange from bar_counts
       union
       select symbol, exchange from daily_bar_counts
     )
     select
       k.symbol,
       k.exchange,
       coalesce(b.bars_1h, '0') as bars_1h,
       coalesce(f.features_1h, '0') as features_1h,
       coalesce(db.daily_bars, '0') as daily_bars,
       coalesce(df.daily_features, '0') as daily_features,
       coalesce(r.regime_labels, '0') as regime_labels
     from instrument_keys k
     left join bar_counts b on b.symbol = k.symbol and b.exchange = k.exchange
     left join feature_counts f on f.symbol = k.symbol and f.exchange = k.exchange
     left join daily_bar_counts db on db.symbol = k.symbol and db.exchange = k.exchange
     left join daily_feature_counts df on df.symbol = k.symbol and df.exchange = k.exchange
     left join regime_counts r on r.symbol = k.symbol and r.exchange = k.exchange
     order by coalesce(b.bars_1h, '0')::int desc, k.symbol asc, k.exchange asc`,
    params,
  );

  const filters: DiscoveryFilters = {
    minAssetBars,
    minFeatureCoveragePct,
    requireRegimeSnapshots,
    maxAssets,
    exchange: exchangeFilter || null,
  };
  const diagnostics: DiscoveryRow[] = rows.map((row) => {
    const bars1h = Number(row.bars_1h);
    const features1h = Number(row.features_1h);
    const dailyBars = Number(row.daily_bars);
    const dailyFeatures = Number(row.daily_features);
    const regimeLabels = Number(row.regime_labels);
    const featureCoverage1hPct = pctOf(features1h, bars1h);
    const dailyFeatureCoveragePct = pctOf(dailyFeatures, dailyBars);
    const regimeCoveragePct = pctOf(regimeLabels, bars1h);
    const notReadyReasons: string[] = [];
    if (bars1h < minAssetBars) notReadyReasons.push(`1h bars ${bars1h} < ${minAssetBars}`);
    if (featureCoverage1hPct === null || featureCoverage1hPct < minFeatureCoveragePct) {
      notReadyReasons.push(`1h feature coverage ${fmt(featureCoverage1hPct)}% < ${minFeatureCoveragePct}%`);
    }
    if (dailyBars === 0) {
      notReadyReasons.push("daily bars missing");
    } else if (dailyFeatureCoveragePct === null || dailyFeatureCoveragePct < minFeatureCoveragePct) {
      notReadyReasons.push(`daily feature coverage ${fmt(dailyFeatureCoveragePct)}% < ${minFeatureCoveragePct}%`);
    }
    if (requireRegimeSnapshots && (regimeCoveragePct === null || regimeCoveragePct < minFeatureCoveragePct)) {
      notReadyReasons.push(`regime coverage ${fmt(regimeCoveragePct)}% < ${minFeatureCoveragePct}%`);
    }
    const notReadyReason = notReadyReasons.length > 0 ? notReadyReasons.join("; ") : null;
    return {
      symbol: row.symbol,
      exchange: row.exchange,
      assetType: inferAssetType(row.symbol),
      bars1h,
      features1h,
      featureCoverage1hPct,
      dailyBars,
      dailyFeatures,
      dailyFeatureCoveragePct,
      regimeLabels,
      regimeCoveragePct,
      isResearchReady: notReadyReasons.length === 0,
      notReadyReason,
      selectionReason: notReadyReason,
    };
  });
  const readyRows = diagnostics.filter((row) => row.isResearchReady);
  const selectedRows = maxAssets === null ? readyRows : readyRows.slice(0, maxAssets);
  const selectedKeys = new Set(selectedRows.map((row) => `${row.symbol}:${row.exchange}`));
  const excludedRows = diagnostics
    .filter((row) => !row.isResearchReady)
    .concat(readyRows
      .filter((row) => !selectedKeys.has(`${row.symbol}:${row.exchange}`))
      .map((row) => ({ ...row, selectionReason: `MAX_ASSETS cap (${maxAssets})` })));

  console.log(
    `[research:p5] discovery filters: MIN_ASSET_BARS=${minAssetBars}, ` +
    `MIN_FEATURE_COVERAGE_PCT=${minFeatureCoveragePct}, REQUIRE_REGIME_SNAPSHOTS=${requireRegimeSnapshots}`,
  );
  console.log(
    `[research:p5] discovery candidates: ${diagnostics.map((row) =>
      `${row.symbol}@${row.exchange} 1hBars=${row.bars1h} 1hFeatures=${row.features1h} ` +
      `1hCoverage=${fmt(row.featureCoverage1hPct)}% dailyBars=${row.dailyBars} ` +
      `dailyFeatures=${row.dailyFeatures} dailyCoverage=${fmt(row.dailyFeatureCoveragePct)}% ` +
      `regimes=${row.regimeLabels}`,
    ).join("; ") || "none"}`,
  );
  console.log(
    `[research:p5] discovery selected: ${selectedRows.map((row) =>
      `${row.symbol}@${row.exchange} 1hBars=${row.bars1h} 1hFeatures=${row.features1h} ` +
      `1hCoverage=${fmt(row.featureCoverage1hPct)}% dailyBars=${row.dailyBars} ` +
      `dailyFeatures=${row.dailyFeatures} dailyCoverage=${fmt(row.dailyFeatureCoveragePct)}% ` +
      `regimes=${row.regimeLabels}`,
    ).join("; ") || "none"}`,
  );

  return { filters, candidates: diagnostics, selected: selectedRows, excluded: excludedRows };
}

async function resolveInstruments(): Promise<InstrumentResolution> {
  const symbols = explicitSymbols();
  if (symbols) {
    const exchange = (process.env.EXCHANGE ?? "COINBASE") as Exchange;
    if (process.env.ASSET_TYPE && symbols.length > 1) {
      console.log("[research:p5] ignoring ASSET_TYPE override because SYMBOLS contains multiple symbols; asset types will be inferred per symbol.");
    }
    return {
      source: "explicit_symbols",
      instruments: symbols.map((symbol) => instrumentFor(symbol, exchange, symbols.length === 1)),
      discovery: null,
    };
  }

  if (isMultiAssetRun()) {
    if (process.env.ASSET_TYPE) {
      console.log("[research:p5] ignoring ASSET_TYPE override during dynamic multi-asset discovery; asset types will be inferred per symbol.");
    }
    const discovery = await discoverStoredInstruments();
    const discovered = discovery.selected.map((row) => instrumentFor(row.symbol, row.exchange));
    console.log(
      `[research:p5] discovered ${discovered.length} stored 1h instrument(s): ` +
      `${discovered.map((instrument) => `${instrument.symbol}@${instrument.exchange}`).join(", ") || "none"}`,
    );
    return { source: "dynamic_discovery", instruments: discovered, discovery };
  }

  return {
    source: "single_asset_default",
    instruments: [instrumentFor("BTC-USD", (process.env.EXCHANGE ?? "COINBASE") as Exchange)],
    discovery: null,
  };
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

function pctFmt(value: number | null | undefined, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)}%` : "n/a";
}

function pctOf(part: number, total: number): number | null {
  return total > 0 ? part / total * 100 : null;
}

function dateOnly(ts: string | null | undefined): string {
  return ts ? ts.slice(0, 10) : "n/a";
}

function gitValue(args: string): string {
  try {
    return execSync(`git ${args}`, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function repoRelativePath(filePath: string | null | undefined): string | null {
  if (!filePath || filePath.trim() === "") return null;
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const relative = path.relative(process.cwd(), absolute);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return absolute;
}

function csvEscape(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function strategyVersionSummary(): Record<string, string> {
  return Object.fromEntries(STRATEGY_REGISTRY.map((strategy) => [strategy.id, strategy.version]));
}

function strategyVersionsText(strategyVersions: Record<string, string>): string {
  return Object.entries(strategyVersions)
    .map(([id, version]) => `${id}=${version}`)
    .join("; ");
}

function windowConfigText(): string {
  return [
    `WINDOWS_PER_REGIME=${process.env.WINDOWS_PER_REGIME ?? "10"}`,
    `WINDOW_BARS=${process.env.WINDOW_BARS ?? String(DEFAULT_PROXY_WINDOW_BARS)}`,
    `MIN_PROXY_WINDOW_BARS=${MIN_PROXY_WINDOW_BARS}`,
    `RUN_CONFIGS=${RUN_CONFIGS.map((config) => `${config.windowBars}b/${config.minDominantRegimePct}%`).join(",")}`,
    `MIN_OPPORTUNITY_TEST_TRADES=${MIN_OPPORTUNITY_TEST_TRADES}`,
  ].join("; ");
}

function runMetadataSection(metadata: ReportRunMetadata): string[] {
  return [
    "## Run Metadata",
    "",
    table(
      ["field", "value"],
      [
        ["branch", metadata.branch],
        ["generated from commit", metadata.generatedFromCommit],
        ["committed in commit", metadata.committedInCommit || "not recorded"],
        ["run timestamp", metadata.runTimestamp],
        ["report path", metadata.reportPath],
        ["log path", metadata.logPath || "unset"],
        ["feature version", metadata.featureVersion],
        ["window config", metadata.windowConfig],
        ["symbols discovered", metadata.symbolsDiscovered.join(", ") || "none"],
      ],
    ),
    "",
    "Strategy versions:",
    "",
    table(
      ["strategy", "version"],
      Object.entries(metadata.strategyVersions).map(([strategy, version]) => [strategy, version]),
    ),
    "",
  ];
}

function appendReportIndex(args: {
  timestamp: string;
  branch: string;
  generatedFromCommit: string;
  committedInCommit?: string | null;
  reportPath: string;
  logPath: string | null;
  exitCode: number;
  assetsAnalyzed: string[];
  strategyVersions: Record<string, string>;
  notes: string;
}): void {
  const indexPath = path.join(process.cwd(), "reports", "p5", "index.csv");
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  const header = [
    "timestamp",
    "branch",
    "generated_from_commit",
    "committed_in_commit",
    "report_path",
    "log_path",
    "exit_code",
    "assets_analyzed",
    "strategy_versions",
    "notes",
  ];
  if (!fs.existsSync(indexPath) || fs.readFileSync(indexPath, "utf8").trim().length === 0) {
    fs.writeFileSync(indexPath, `${header.join(",")}\n`);
  }
  const row = [
    args.timestamp,
    args.branch,
    args.generatedFromCommit,
    args.committedInCommit ?? "",
    args.reportPath,
    args.logPath,
    args.exitCode,
    args.assetsAnalyzed.join(";"),
    strategyVersionsText(args.strategyVersions),
    args.notes,
  ].map(csvEscape).join(",");
  fs.appendFileSync(indexPath, `${row}\n`);
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

async function skippedEquityAssetsSection(): Promise<string[]> {
  const pool = getPgPool();
  const { rows } = await pool.query<{
    symbol: string;
    bars_1h: string;
    daily_bars: string;
    daily_features: string;
  }>(
    `with targets as (
       select unnest($1::text[]) as symbol
     ),
     bars_1h as (
       select symbol, count(*)::text as bars_1h
       from market_bars
       where timeframe = '1h' and symbol = any($1)
       group by symbol
     ),
     daily_bars as (
       select symbol, count(*)::text as daily_bars
       from market_bars
       where timeframe = '1d' and symbol = any($1)
       group by symbol
     ),
     daily_features as (
       select b.symbol, count(distinct b.ts)::text as daily_features
       from market_bars b
       join feature_snapshots f
         on f.symbol = b.symbol
        and f.exchange = b.exchange
        and f.timeframe = b.timeframe
        and f.ts = b.ts
        and f.feature_version = $2
       where b.timeframe = '1d' and b.symbol = any($1)
       group by b.symbol
     )
     select
       t.symbol,
       coalesce(b.bars_1h, '0') as bars_1h,
       coalesce(db.daily_bars, '0') as daily_bars,
       coalesce(df.daily_features, '0') as daily_features
     from targets t
     left join bars_1h b on b.symbol = t.symbol
     left join daily_bars db on db.symbol = t.symbol
     left join daily_features df on df.symbol = t.symbol
     order by t.symbol asc`,
    [EQUITY_WATCHLIST_TARGETS.map((target) => target.symbol), FEATURE_VERSION],
  );
  const counts = new Map(rows.map((row) => [row.symbol.toUpperCase(), row]));
  const skipped = EQUITY_WATCHLIST_TARGETS.map((target) => {
    const row = counts.get(target.symbol);
    const bars1h = Number(row?.bars_1h ?? 0);
    const dailyBars = Number(row?.daily_bars ?? 0);
    const dailyFeatures = Number(row?.daily_features ?? 0);
    const dailyCoverage = pctOf(dailyFeatures, dailyBars);
    const reason = bars1h === 0
      ? target.missingBarsReason
      : "equity/ETF research remains disabled until proper ingestion, features, and regimes are ready";
    return [
      target.symbol,
      target.assetType,
      String(bars1h),
      String(dailyBars),
      String(dailyFeatures),
      `${fmt(dailyCoverage)}%`,
      reason,
    ];
  });

  if (skipped.length === 0) {
    return [
      "## Skipped Assets",
      "",
      "No equity watchlist assets were skipped for missing stored 1h bars.",
      "",
    ];
  }

  return [
    "## Skipped Assets",
    "",
    "Equity/ETF watchlist assets remain out of scope for this branch until proper 1h bars, daily bars/features, and regimes are ingested. These diagnostics are informational only; this branch does not add equity ingestion.",
    "",
    table(["asset", "type", "1h bars", "daily bars", "daily features", "daily feature coverage", "reason"], skipped),
    "",
  ];
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
    risk: researchRiskOverlayConfig(),
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

function backtestCacheKey(input: BacktestInput): string {
  const strategyVersion = input.strategyRouter?.version ??
    STRATEGY_REGISTRY.find((strategy) => strategy.id === input.config.strategyId)?.version ??
    "unknown";
  const firstBar = input.bars[0]?.ts ?? "none";
  const lastBar = input.bars[input.bars.length - 1]?.ts ?? "none";
  return JSON.stringify({
    config: {
      symbol: input.config.symbol,
      exchange: input.config.exchange,
      assetType: input.config.assetType ?? "UNKNOWN",
      dataSource: input.config.dataSource ?? "unknown",
      timeframe: input.config.timeframe,
      strategyId: input.config.strategyId,
      strategyVersion,
      featureVersion: input.config.featureVersion,
      startTs: input.config.startTs,
      endTs: input.config.endTs,
      initialCapital: input.config.initialCapital,
      riskPerTradePct: input.config.riskPerTradePct,
      maxPositionPct: input.config.maxPositionPct,
      maxConcurrentPositions: input.config.maxConcurrentPositions,
      allowShorts: input.config.allowShorts ?? false,
      feeBps: input.config.feeBps,
      slippageBps: input.config.slippageBps,
      defaultRewardRisk: input.config.defaultRewardRisk ?? null,
      closeOpenPositionAtEnd: input.config.closeOpenPositionAtEnd,
      enterOnNextBarOpen: input.config.enterOnNextBarOpen,
      sameBarStopFirst: input.config.sameBarStopFirst,
      risk: input.config.risk ?? null,
      routerId: input.strategyRouter?.id ?? null,
      routerVersion: input.strategyRouter?.version ?? null,
    },
    data: {
      bars: input.bars.length,
      firstBar,
      lastBar,
      features: input.features.length,
      dailyFeatures: input.dailyFeatures?.length ?? 0,
      regimes: input.regimes?.length ?? 0,
    },
  });
}

function runBacktest(input: BacktestInput): BacktestRunResult {
  const key = backtestCacheKey(input);
  const cached = backtestResultCache.get(key);
  if (cached) return cached;
  const result = runBacktestRaw(input);
  backtestResultCache.set(key, result);
  return result;
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

function tradePoolStats(trades: SimulatedTrade[]): TradePoolStats {
  const profit = grossProfit(trades);
  const lossAbs = grossLossAbs(trades);
  return {
    grossProfit: profit,
    grossLossAbs: lossAbs,
    pooledProfitFactor: lossAbs === 0 ? null : profit / lossAbs,
    pooledExpectancy: trades.length === 0 ? null : trades.reduce((sum, trade) => sum + trade.pnl, 0) / trades.length,
    tradeCount: trades.length,
  };
}

function latestRegimeAtOrBefore(regimes: RegimeContext[] | undefined, ts: string): RegimeContext | null {
  if (!regimes || regimes.length === 0) return null;
  let latest: RegimeContext | null = null;
  for (const regime of regimes) {
    if (regime.ts <= ts) latest = regime;
    if (regime.ts > ts) break;
  }
  return latest;
}

function latestClosedDailyFor(dailyFeatures: FeatureSnapshot[] | undefined, current: FeatureSnapshot): FeatureSnapshot | null {
  if (!dailyFeatures || dailyFeatures.length === 0) return null;
  const currentMs = Date.parse(current.ts);
  let latest: FeatureSnapshot | null = null;
  for (const candidate of dailyFeatures) {
    const openMs = Date.parse(candidate.ts);
    if (candidate.symbol !== current.symbol || candidate.exchange !== current.exchange || candidate.timeframe !== "1d") continue;
    if (openMs + DAY_MS <= currentMs) latest = candidate;
    if (openMs > currentMs) break;
  }
  return latest;
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

function routerMetricAudit(
  base: BacktestInput,
  windows: RegimeCandidateWindow[],
  routerConfig: RegimeStrategyRouterConfig = DEFAULT_A6_REGIME_ROUTER_CONFIG,
): RouterMetricAudit {
  const router = routerConfig === DEFAULT_A6_REGIME_ROUTER_CONFIG
    ? defaultA6RegimeRouter
    : createRegimeStrategyRouter(routerConfig);
  const results = windows.map((window) => ({
    window,
    result: runBacktest({
      ...sliceInput(base, window, routerConfig.id),
      strategyRouter: router,
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
  const customWeight = strategyIds.length === 0 ? 0 : 1 / strategyIds.length;
  const equal: PortfolioBacktestConfig = { mode: "equal_weight", strategyIds };
  const custom: PortfolioBacktestConfig = {
    mode: "custom_weight",
    strategyIds,
    weights: Object.fromEntries(strategyIds.map((strategyId) => [strategyId, customWeight])),
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
      losingTradeCount: allTrades.filter((trade) => trade.pnl < 0).length,
      stopLossExitCount: allTrades.filter((trade) => trade.reasonExited === "stop_loss").length,
      noTradeWindows: results.filter((r) => r.trades.length === 0).length,
      avgReturnToDrawdown: avg(rtdds),
    };
  });
}

function summarizeRiskOverlayWindows(
  base: BacktestInput,
  windows: RegimeCandidateWindow[],
): RiskOverlayReportSummary | null {
  if (base.config.risk?.enabled !== true) return null;
  const strategyId = STRATEGY_REGISTRY[0].id;
  const overlays = windows
    .map((window) => runBacktest(sliceInput(base, window, strategyId)).riskOverlay)
    .filter((overlay): overlay is RiskOverlaySummary => overlay !== undefined);
  if (overlays.length === 0) return null;

  const blockedByReason: Record<string, number> = {};
  for (const overlay of overlays) {
    for (const [reason, count] of Object.entries(overlay.riskBlockedByReason)) {
      blockedByReason[reason] = (blockedByReason[reason] ?? 0) + count;
    }
  }

  const rawMetrics = overlays.map((overlay) => overlay.rawMetrics);
  const riskAdjustedMetrics = overlays.map((overlay) => overlay.riskAdjustedMetrics);
  return {
    strategyId,
    windows: overlays.length,
    rawTradeCount: rawMetrics.reduce((sum, metrics) => sum + metrics.numberOfTrades, 0),
    riskAdjustedTradeCount: riskAdjustedMetrics.reduce((sum, metrics) => sum + metrics.numberOfTrades, 0),
    blockedTrades: overlays.reduce((sum, overlay) => sum + overlay.riskBlockedTrades, 0),
    blockedByReason,
    rawMaxDrawdownPct: rawMetrics.length === 0 ? null : Math.max(...rawMetrics.map((metrics) => metrics.maxDrawdownPct)),
    riskAdjustedMaxDrawdownPct: riskAdjustedMetrics.length === 0
      ? null
      : Math.max(...riskAdjustedMetrics.map((metrics) => metrics.maxDrawdownPct)),
    rawAvgReturnPct: avg(rawMetrics.map((metrics) => metrics.totalReturnPct)),
    riskAdjustedAvgReturnPct: avg(riskAdjustedMetrics.map((metrics) => metrics.totalReturnPct)),
    rawAvgProfitFactor: avg(
      rawMetrics.map((metrics) => metrics.profitFactor).filter((value): value is number => value !== null),
    ),
    riskAdjustedAvgProfitFactor: avg(
      riskAdjustedMetrics.map((metrics) => metrics.profitFactor).filter((value): value is number => value !== null),
    ),
    rawAvgExpectancy: avg(
      rawMetrics.map((metrics) => metrics.expectancy).filter((value): value is number => value !== null),
    ),
    riskAdjustedAvgExpectancy: avg(
      riskAdjustedMetrics.map((metrics) => metrics.expectancy).filter((value): value is number => value !== null),
    ),
  };
}

function routerFullStatsFromAudit(audit: RouterMetricAudit, routerSummary: RoutingSummary): FullStats {
  const returns = audit.rows.map((r) => r.returnPct);
  const drawdowns = audit.rows.map((r) => r.maxDrawdownPct);
  const exposures = audit.rows.map((r) => r.exposurePct).filter((v): v is number => v !== null);
  return {
    label: routerSummary.label,
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
    losingTradeCount: 0,
    stopLossExitCount: 0,
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
      losingTradeCount: allTrades.filter((trade) => trade.pnl < 0).length,
      stopLossExitCount: allTrades.filter((trade) => trade.reasonExited === "stop_loss").length,
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

function resolvedAssetLine(resolution: InstrumentResolution, summaries: AssetSummary[]): string {
  const analyzed = summaries.map((summary) => summary.symbol).join(", ") || "none";
  if (resolution.source === "explicit_symbols") {
    return `Assets analyzed: ${summaries.length} of ${resolution.instruments.length} requested assets (${analyzed}).`;
  }
  if (resolution.source === "dynamic_discovery") {
    return `Assets analyzed: ${summaries.length} of ${resolution.instruments.length} selected/discovered assets (${analyzed}).`;
  }
  return `Assets analyzed: ${summaries.length} of ${resolution.instruments.length} resolved default assets (${analyzed}).`;
}

function topInSampleOpportunitySummary(summaries: AssetSummary[]): string {
  const top = summaries
    .flatMap((summary) => summary.regimeStrategyStats)
    .filter((row) => row.tradeCount > 0 && row.globalExpectancy !== null)
    .sort((a, b) => (b.globalExpectancy ?? Number.NEGATIVE_INFINITY) - (a.globalExpectancy ?? Number.NEGATIVE_INFINITY))
    .slice(0, 5)
    .map((row) =>
      `${row.symbol} ${row.regime} ${row.strategyId} (` +
      `expectancy ${fmt(row.globalExpectancy, 4)}, avg return ${fmt(row.avgReturn)}%, trades ${row.tradeCount})`,
    );
  return top.length > 0 ? top.join("; ") : "none";
}

function opportunityValidationSummary(summaries: AssetSummary[]): string {
  const ranked = trainRankedOpportunityCandidates(summaries).slice(0, CROSS_ASSET_OPPORTUNITY_TOP_N);
  if (ranked.length === 0) return "No train-ranked opportunity candidates were available.";
  const { totalFolds, counts } = opportunityFoldValidationCounts(summaries);
  const rows = ranked.map((candidate) => ({
    candidate,
    verdict: opportunityFinalVerdict(candidate, counts.get(opportunityCandidateKey(candidate)) ?? 0, totalFolds),
  }));
  const validated = rows.filter((row) => row.verdict === "VALIDATED");
  const needsMoreData = rows.filter((row) => row.verdict === "NEEDS MORE DATA").length;
  const notValidated = rows.filter((row) => row.verdict === "NOT VALIDATED").length;
  if (validated.length === 0) {
    return `None yet; ${needsMoreData} need more data and ${notValidated} are not validated across the top ${ranked.length} train-ranked candidates.`;
  }
  return validated
    .slice(0, 5)
    .map(({ candidate }) => `${candidate.symbol} ${candidate.regime} ${candidate.strategyId}`)
    .join("; ");
}

function routerValidationSummary(summaries: AssetSummary[]): string {
  if (summaries.length === 0) return "No assets had enough data for router validation.";
  const validated = summaries.filter((summary) => summary.walkForward?.finalVerdict === "VALIDATED").length;
  const needsMoreData = summaries.filter((summary) => summary.walkForward?.finalVerdict === "NEEDS MORE DATA").length;
  const notValidated = summaries.filter((summary) => summary.walkForward?.finalVerdict === "NOT VALIDATED").length;
  const insufficient = summaries.length - validated - needsMoreData - notValidated;
  return `${validated} validated, ${needsMoreData} need more data, ${notValidated} not validated, ${insufficient} insufficient.`;
}

function executiveSummarySection(resolution: InstrumentResolution, summaries: AssetSummary[]): string[] {
  const totalBars = summaries.reduce((sum, summary) => sum + summary.dataCoverage.bars, 0);
  const totalFeatures = summaries.reduce((sum, summary) => sum + summary.dataCoverage.features, 0);
  const totalRegimes = summaries.reduce((sum, summary) => sum + summary.dataCoverage.regimes, 0);
  const regimeSources = [...new Set(summaries.map((summary) => summary.regimeSourceLabel))].join(", ") || "none";
  const focusAssets = ["SOL-USD", "ETH-USD", "LINK-USD", "AVAX-USD"]
    .filter((symbol) => summaries.some((summary) => summary.symbol === symbol))
    .map((symbol) => symbol.replace("-USD", ""))
    .join(", ");
  const conclusion = summaries.length === 0
    ? "No research-ready assets were available in this run."
    : `No router or cross-asset candidate should be treated as validated production edge yet. Current evidence supports further research into refined momentum-continuation strategies in TREND_UP conditions${focusAssets ? `, especially across ${focusAssets}` : ""}.`;

  return [
    "## Executive Summary",
    "",
    table(
      ["item", "summary"],
      [
        ["assets analyzed", resolvedAssetLine(resolution, summaries).replace(/^Assets analyzed: /, "")],
        ["data coverage", `${totalBars} stored bars, ${totalFeatures} 1h feature rows, ${totalRegimes} regime labels used across analyzed assets`],
        ["regime source", regimeSources],
        ["best in-sample opportunity candidates", topInSampleOpportunitySummary(summaries)],
        ["validated candidates", opportunityValidationSummary(summaries)],
        ["router validation status", routerValidationSummary(summaries)],
        ["strategy refinement direction", "Keep refined variants beside base strategies and promote only variants that survive held-out and rolling-fold validation."],
        ["main conclusion", conclusion],
        ["next action", "Use the validation and refinement summaries below to decide the next research experiment; do not move to risk engine or execution work from this evidence alone."],
      ],
    ),
    "",
  ];
}

function regimeSourceExplanationSection(): string[] {
  return [
    "## Regime Source Explanation",
    "",
    "`gpt_a6_detector_snapshots` are persisted labels produced by the A6/GPT regime detector.",
    "",
    "`deterministic_proxy_research_snapshots` are deterministic research labels generated to support repeatable backtesting and validation. They are useful for controlled research but should not be described as GPT/A6 validation.",
    "",
    "`ohlcv_fallback_labels` are temporary in-memory labels built directly from OHLCV and feature data when persisted regime snapshots are unavailable.",
    "",
    "Report rule: Do not describe deterministic proxy snapshots or OHLCV fallback labels as GPT/A6 detector validation.",
    "",
  ];
}

function discoveryReadinessSection(discovery: DiscoveryResult | null): string[] {
  if (!discovery) {
    return [
      "## Discovery Readiness Diagnostics",
      "",
      "Dynamic discovery was not used for this run. Assets were resolved from explicit symbols or the single-asset default.",
      "",
    ];
  }
  const { filters, selected, excluded } = discovery;
  return [
    "## Discovery Readiness Diagnostics",
    "",
    "Dynamic discovery includes instruments that pass the readiness filters below across stored 1h bars/features and daily bars/features. Persisted regime snapshots are counted for visibility but are optional unless `REQUIRE_REGIME_SNAPSHOTS=true`, because OHLCV fallback labels can still support research runs.",
    "",
    table(
      ["filter", "value"],
      [
        ["MIN_ASSET_BARS", String(filters.minAssetBars)],
        ["MIN_FEATURE_COVERAGE_PCT", fmt(filters.minFeatureCoveragePct)],
        ["REQUIRE_REGIME_SNAPSHOTS", String(filters.requireRegimeSnapshots)],
        ["MAX_ASSETS", filters.maxAssets === null ? "none" : String(filters.maxAssets)],
        ["EXCHANGE", filters.exchange ?? "any"],
      ],
    ),
    "",
    "Selected assets:",
    "",
    table(
      ["asset", "exchange", "type", "1h bars", "1h features", "1h feature coverage", "daily bars", "daily features", "daily feature coverage", "regime labels", "regime coverage", "ready"],
      selected.length > 0
        ? selected.map((row) => [
            row.symbol,
            row.exchange,
            row.assetType,
            String(row.bars1h),
            String(row.features1h),
            `${fmt(row.featureCoverage1hPct)}%`,
            String(row.dailyBars),
            String(row.dailyFeatures),
            `${fmt(row.dailyFeatureCoveragePct)}%`,
            String(row.regimeLabels),
            `${fmt(row.regimeCoveragePct)}%`,
            String(row.isResearchReady),
          ])
        : [["none", "n/a", "n/a", "n/a", "n/a", "n/a", "n/a", "n/a", "n/a", "n/a", "n/a", "false"]],
    ),
    "",
    "Excluded assets:",
    "",
    table(
      ["asset", "exchange", "type", "1h bars", "1h features", "1h feature coverage", "daily bars", "daily features", "daily feature coverage", "regime labels", "regime coverage", "ready", "reason"],
      excluded.length > 0
        ? excluded.map((row) => [
            row.symbol,
            row.exchange,
            row.assetType,
            String(row.bars1h),
            String(row.features1h),
            `${fmt(row.featureCoverage1hPct)}%`,
            String(row.dailyBars),
            String(row.dailyFeatures),
            `${fmt(row.dailyFeatureCoveragePct)}%`,
            String(row.regimeLabels),
            `${fmt(row.regimeCoveragePct)}%`,
            String(row.isResearchReady),
            row.selectionReason ?? row.notReadyReason ?? "not selected",
          ])
        : [["none", "n/a", "n/a", "n/a", "n/a", "n/a", "n/a", "n/a", "n/a", "n/a", "n/a", "false", "none"]],
    ),
    "",
  ];
}

function strategyRecommendationSummarySection(): string[] {
  return [
    "## Strategy Recommendation Summary",
    "",
    table(
      ["strategy", "current finding", "research action"],
      [
        ["momentum_continuation", "Primary base-strategy investigation candidate, especially in TREND_UP conditions.", "Continue refining confidence, entry-quality, and rolling-fold survival filters. Do not promote yet."],
        ["momentum_continuation_refined_v1", "Research-only refined variant with directional quality improvement, but not validated production edge.", "Keep research-only until held-out and rolling-fold criteria pass."],
        ["trend_pullback_refined_v1", "Possible high-PF niche, but current gates appear over-filtered and sample-limited.", "Investigate v3 loosening carefully without replacing the base strategy. Do not promote."],
        ["breakout_expansion_refined_v1", "TREND_UP / volatility-expansion specialist candidate, not broadly validated.", "Pause broad tuning unless specifically studying false-breakout reduction."],
        ["mean_reversion_refined_v1", "Needs a cleaner setup thesis; current refinement underperforms and gating alone is not enough.", "Rethink the setup thesis before further tuning. Do not simply loosen gates."],
      ],
    ),
    "",
  ];
}

function knownLimitationsSection(): string[] {
  return [
    "## Known Limitations",
    "",
    "- This remains research only; no live execution, broker integration, order manager, or capital deployment path is introduced.",
    "- Regime labels are deterministic proxy research snapshots unless GPT/A6 snapshots are explicitly present.",
    "- Deterministic proxy regimes are not GPT/A6 detector validation.",
    "- OHLCV fallback labels are temporary in-memory research labels, not persisted detector output.",
    "- Portfolio equity realizes scaled simulated trade PnL at exits and does not model full broker-grade portfolio accounting or intra-trade capital contention.",
    "- Strategy simulations preserve the current long-only/default P4 assumptions unless explicitly configured otherwise.",
    "- The optional risk overlay is a backtest-only simulation. It does not create trade intents, orders, fills, persistent positions, or execution state.",
    "- Overlay exposure checks inherit the v1 backtest engine's single-position model; cross-strategy portfolio contention is not broker-grade accounting.",
    "- Sample sizes are limited by selected windows, available bars, features, and regime labels.",
    "- Some high-expectancy candidates have too few trades to trust.",
    "- Candidate rankings are not validated until held-out and rolling-fold validation passes.",
    "- Equity/ETF research is skipped until bars, features, and regimes are ingested.",
    "- staticStrategyFullStats and portfolioComparisonStats re-run backtests independently of routingSummaries and portfolioSummaries; this is intentional to keep comparison sections isolated but doubles computation.",
    "",
  ];
}

function nextActionListSection(): string[] {
  return [
    "## Next Action List",
    "",
    "1. Keep Cross-Asset Opportunity Walk-Forward Validation as the gate before treating any candidate as edge.",
    "2. Use Cross-Asset Validated Candidate Summary as the promotion checkpoint for candidate research.",
    "3. Keep the Skipped Assets section for SPY, QQQ, AAPL, MSFT, and NVDA until equity/ETF bars are ingested.",
    "4. Add or revise refined strategy variants without replacing base strategies.",
    "5. Compare base vs refined variants across assets, regimes, held-out windows, and rolling folds.",
    "6. Promote only variants that survive held-out and rolling-fold validation.",
    "7. Add equity/ETF ingestion after the crypto research layer is stable.",
    "8. Keep the risk overlay simulation-only; do not add trade intents, paper trading, broker integration, or live execution in this phase.",
    "",
  ];
}

function implementationSummarySection(heading = "### Implementation Summary"): string[] {
  return [
    heading,
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
    "- Added Validation Configuration Comparison: side-by-side runs across windowBars in {144, 336} x minDominantRegimePct in {50%, 65%}. Primary config (most windows) drives the detailed sections; all four configs appear in the comparison table.",
    "- Added Router Configuration Comparison (In-Sample Discovery): experimental router configs are evaluated against the default A6 router and static benchmarks on the primary-config windows. Maps are derived at runtime from the primary validation aggregates and explicitly labeled as in-sample hypothesis discovery.",
    "- Added Walk-Forward Router Validation: chronological 70/30 train/test split plus rolling expanding-window folds. Router maps are derived from train windows only and scored on held-out test windows.",
    "- Added Cross-Asset Opportunity Walk-Forward Validation: asset/regime/strategy candidates are ranked from train windows only, scored on held-out test windows, and checked across rolling expanding-window folds before any candidate can be called validated.",
    "- Added research-only strategy refinement variants beside the four base strategies and a base-vs-refined comparison section for expectancy, profit factor, drawdown, trade count, and walk-forward survival.",
    "- Added Strategy Refinement Candidate Results: refined variants are compared against their base strategies on held-out test-window metrics and rolling fold consistency before receiving conservative research verdicts.",
    "- Added P5 report run metadata, `reports/p5/index.csv` append-only report indexing, pooled held-out trade stats, fold denominator transparency, over-filtering warnings, and Gate Availability Diagnostics.",
    "- Multi-asset research runs dynamically discover research-ready stored instruments unless `SYMBOLS` is provided explicitly; readiness is filtered by minimum 1h bars, 1h feature coverage, and daily feature coverage, while persisted regime snapshots remain optional because OHLCV fallback labels exist.",
    "- Added daily feature readiness diagnostics before equity/ETF expansion so cross-timeframe research inputs are visible without enabling equity ingestion.",
    "- Added an optional, disabled-by-default P6B risk overlay that preserves raw metrics and reports separate risk-adjusted simulation metrics without introducing execution behavior.",
    "",
  ];
}

function strategyAnalyticsSection(heading = "### Strategy Analytics"): string[] {
  return [
    heading,
    "",
    "New metrics now emitted by `BacktestMetrics`: `expectancy`, `avgWin`, `avgLoss`, `maxWinningStreak`, `maxLosingStreak`, `exposurePct`, `avgTradeDurationBars`, `avgTradeDurationMs`, `medianTradeDurationBars`, `medianTradeDurationMs`, `sharpeRatio`, `sortinoRatio`, `profitPerBar`, `returnToDrawdown`, and `tradeFrequency`.",
    "",
    "Backward-compatible P4 names remain in place: `averageWinner`, `averageLoser`, `expectancyPerTrade`, `sharpeApprox`, `sortinoApprox`, `exposureTimePct`, `averageHoldHours`, and `maxConsecutiveLosses`.",
    "",
    "Validation coverage added in `_smoke/backtest.ts`: zero trades, one trade, all winners, all losers, mixed outcomes, A6 routed research runs, and portfolio allocation safety.",
    "",
  ];
}

function architectureChangesSection(heading = "### Architecture Changes"): string[] {
  return [
    heading,
    "",
    "- A6 routing is configuration-driven through `createRegimeStrategyRouter`; the engine receives a router interface and does not know the regime map.",
    "- Regime validation prefers persisted snapshots, but the report labels whether those rows came from the GPT/A6 detector or deterministic proxy research generation. If none exist, it builds in-memory OHLCV fallback labels.",
    "- `regime -> []` and missing regime mappings produce no trade, allowing future capital-preservation experiments.",
    "- Portfolio research validates `sum(weights) <= 100%` and rejects implicit leverage.",
    "- Validation tooling accepts `symbol`, `exchange`, `assetType`, and `dataSource` for multi-asset expansion.",
    "- PORTFOLIO_REGIME_WEIGHTS extracted as a module-level constant shared by portfolio summaries and comparison stats.",
    "",
  ];
}

function issuesFoundSection(heading = "### Issues Found"): string[] {
  return [
    heading,
    "",
    "- Deterministic proxy research snapshots and OHLCV fallback labels are not described as GPT/A6 detector validation.",
    "- BTC-USD data coverage is reported per run as bars, executable bars, 1h features, daily features, and persisted regimes. If any coverage falls short, the report keeps sample counts lower rather than manufacturing windows.",
    "- If meaningful proxy windows cannot provide the requested windows per regime, the report intentionally keeps lower sample counts rather than shrinking to 1-2 bar windows.",
    "- Current portfolio research uses scaled simulated trade PnL and should not be treated as a full broker-grade portfolio accounting engine.",
    "",
  ];
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
    "#### Router Metric Audit",
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
    "#### Router vs Best Static Strategy Comparison",
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
    "#### Regime-Window Purity Diagnostics",
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

function buildExperimentalRouterConfigs(
  aggregates: AggregatedRegimeMetrics[],
  defaultRouterAudit: RouterMetricAudit,
): RegimeStrategyRouterConfig[] {
  // momentum_only: all regimes → momentum_continuation
  const momentumOnlyMap: RegimeStrategyMap = Object.fromEntries(
    REQUIRED_REGIMES.map((r) => [r, ["momentum_continuation"] as string[]]),
  );

  // top_by_regime_return: best avgReturn strategy per regime (any return, even negative)
  const topByReturnMap: RegimeStrategyMap = {};
  for (const regime of REQUIRED_REGIMES) {
    const sorted = aggregates
      .filter((a) => a.regime === regime && a.samples > 0 && a.averageReturn !== null)
      .sort((a, b) => (b.averageReturn ?? Number.NEGATIVE_INFINITY) - (a.averageReturn ?? Number.NEGATIVE_INFINITY));
    topByReturnMap[regime] = sorted.length > 0 ? [sorted[0].strategyId] : [];
  }

  // top_by_regime_retdd: best ret/DD strategy per regime; no trade if no strategy has ret/DD > 0
  const topByRtDDMap: RegimeStrategyMap = {};
  for (const regime of REQUIRED_REGIMES) {
    const sorted = aggregates
      .filter((a) => a.regime === regime && a.samples > 0 && a.returnToDrawdown !== null && a.returnToDrawdown > 0)
      .sort((a, b) => (b.returnToDrawdown ?? Number.NEGATIVE_INFINITY) - (a.returnToDrawdown ?? Number.NEGATIVE_INFINITY));
    topByRtDDMap[regime] = sorted.length > 0 ? [sorted[0].strategyId] : [];
  }

  // conservative: only trade if the best strategy for the regime has avgReturn > 0 AND avgPF > 1
  const conservativeMap: RegimeStrategyMap = {};
  for (const regime of REQUIRED_REGIMES) {
    const sorted = aggregates
      .filter((a) => a.regime === regime && a.samples > 0)
      .sort((a, b) => (b.averageReturn ?? Number.NEGATIVE_INFINITY) - (a.averageReturn ?? Number.NEGATIVE_INFINITY));
    const best = sorted[0];
    const qualifies = best !== undefined &&
      (best.averageReturn ?? Number.NEGATIVE_INFINITY) > 0 &&
      (best.averageProfitFactor ?? 0) > 1;
    conservativeMap[regime] = qualifies ? [best.strategyId] : [];
  }

  // no_trade_in_bad_regimes: default A6 map, but blank out any regime where the default router
  // had negative avg return across the selected windows
  const perRegimeAvgReturn: Partial<Record<RegimeLabel, number | null>> = {};
  for (const regime of REQUIRED_REGIMES) {
    const regimeRows = defaultRouterAudit.rows.filter((r) => r.regime === regime);
    perRegimeAvgReturn[regime] = avg(regimeRows.map((r) => r.returnPct));
  }
  const noTradeInBadMap: RegimeStrategyMap = {};
  for (const regime of REQUIRED_REGIMES) {
    const regimeReturn = perRegimeAvgReturn[regime];
    const defaultStrategies = DEFAULT_A6_REGIME_STRATEGY_MAP[regime] ?? [];
    noTradeInBadMap[regime] = regimeReturn != null && regimeReturn > 0 ? [...defaultStrategies] : [];
  }

  return [
    { id: "conservative_router", version: "research.v1", regimeStrategyMap: conservativeMap },
    { id: "momentum_only_router", version: "research.v1", regimeStrategyMap: momentumOnlyMap },
    { id: "top_by_regime_return_router", version: "research.v1", regimeStrategyMap: topByReturnMap },
    { id: "top_by_regime_retdd_router", version: "research.v1", regimeStrategyMap: topByRtDDMap },
    { id: "no_trade_in_bad_regimes_router", version: "research.v1", regimeStrategyMap: noTradeInBadMap },
  ];
}

function routerFullStatsForConfig(
  base: BacktestInput,
  windows: RegimeCandidateWindow[],
  config: RegimeStrategyRouterConfig,
): FullStats {
  const audit = routerMetricAudit(base, windows, config);
  const rtdds = audit.rows
    .map((r) => r.maxDrawdownPct === 0 ? null : r.returnPct / r.maxDrawdownPct)
    .filter((v): v is number => v !== null);
  const syntheticEntry: RoutingSummary = {
    label: config.id,
    samples: audit.windows,
    avgReturn: audit.averageReturnPct,
    avgDrawdown: avg(audit.rows.map((r) => r.maxDrawdownPct)),
    avgProfitFactor: audit.reportedAverageProfitFactor,
    avgExpectancy: audit.averageExpectancy,
    avgTrades: avg(audit.rows.map((r) => r.tradeCount)),
    avgExposure: avg(audit.rows.map((r) => r.exposurePct).filter((v): v is number => v !== null)),
    avgReturnToDrawdown: avg(rtdds),
  };
  return routerFullStatsFromAudit(audit, syntheticEntry);
}

function experimentalRouterStats(
  base: BacktestInput,
  windows: RegimeCandidateWindow[],
  configs: RegimeStrategyRouterConfig[],
): FullStats[] {
  return configs.map((config) => routerFullStatsForConfig(base, windows, config));
}

function computeAggregatesForWindows(base: BacktestInput, windows: RegimeCandidateWindow[]): AggregatedRegimeMetrics[] {
  const strategyIds = STRATEGY_REGISTRY.map((strategy) => strategy.id);
  const backtests: RegimeWindowBacktest[] = [];
  for (const window of windows) {
    for (const strategyId of strategyIds) {
      backtests.push({ window, strategyId, result: runBacktest(sliceInput(base, window, strategyId)) });
    }
  }
  return aggregateRegimeMetrics(backtests, strategyIds);
}

interface RegimeStrategyStat {
  symbol: string;
  regime: RegimeLabel;
  strategyId: string;
  samples: number;
  avgReturn: number | null;
  globalProfitFactor: number | null;
  globalExpectancy: number | null;
  maxDrawdown: number | null;
  avgReturnToDrawdown: number | null;
  tradeCount: number;
  medianPurity: number | null;
}

// True trade-level global stats per (regime, strategy) for one asset, used to power
// the Cross-Asset Opportunity Ranking. Trades are pooled within each regime's windows.
function crossAssetRegimeStrategyStats(
  symbol: string,
  base: BacktestInput,
  windows: RegimeCandidateWindow[],
): RegimeStrategyStat[] {
  const strategyIds = STRATEGY_REGISTRY.map((strategy) => strategy.id);
  const out: RegimeStrategyStat[] = [];
  for (const regime of REQUIRED_REGIMES) {
    const regimeWindows = windows.filter((w) => w.regime === regime);
    if (regimeWindows.length === 0) continue;
    const medianPurity = medianOf(regimeWindows.map((w) => w.dominantRegimePct));
    for (const strategyId of strategyIds) {
      const results = regimeWindows.map((w) => runBacktest(sliceInput(base, w, strategyId)));
      const allTrades = results.flatMap((r) => r.trades);
      const metrics = results.map((r) => r.metrics);
      const returns = metrics.map((m) => m.totalReturnPct);
      const drawdowns = metrics.map((m) => m.maxDrawdownPct);
      const rtdds = metrics.map((m) => m.returnToDrawdown).filter((v): v is number => v !== null);
      const lossAbs = grossLossAbs(allTrades);
      out.push({
        symbol,
        regime,
        strategyId,
        samples: regimeWindows.length,
        avgReturn: avg(returns),
        globalProfitFactor: lossAbs === 0 ? null : grossProfit(allTrades) / lossAbs,
        globalExpectancy: allTrades.length === 0 ? null : allTrades.reduce((s, t) => s + t.pnl, 0) / allTrades.length,
        maxDrawdown: drawdowns.length === 0 ? null : Math.max(...drawdowns),
        avgReturnToDrawdown: avg(rtdds),
        tradeCount: allTrades.length,
        medianPurity,
      });
    }
  }
  return out;
}

function opportunityCandidateKey(candidate: Pick<OpportunityCandidateValidation, "symbol" | "regime" | "strategyId">): string {
  return `${candidate.symbol}|${candidate.regime}|${candidate.strategyId}`;
}

function opportunityPeriodStats(
  base: BacktestInput,
  windows: RegimeCandidateWindow[],
  regime: RegimeLabel,
  strategyId: string,
): OpportunityCandidatePeriodStats {
  const regimeWindows = windows.filter((window) => window.regime === regime);
  const results = regimeWindows.map((window) => runBacktest(sliceInput(base, window, strategyId)));
  const allTrades = results.flatMap((result) => result.trades);
  const returns = results.map((result) => result.metrics.totalReturnPct);
  const drawdowns = results.map((result) => result.metrics.maxDrawdownPct);
  const lossAbs = grossLossAbs(allTrades);
  return {
    samples: regimeWindows.length,
    avgReturn: avg(returns),
    globalProfitFactor: lossAbs === 0 ? null : grossProfit(allTrades) / lossAbs,
    globalExpectancy: allTrades.length === 0 ? null : allTrades.reduce((sum, trade) => sum + trade.pnl, 0) / allTrades.length,
    maxDrawdown: drawdowns.length === 0 ? null : Math.max(...drawdowns),
    tradeCount: allTrades.length,
  };
}

function opportunityCandidatePass(stats: OpportunityCandidatePeriodStats): boolean {
  return (
    stats.avgReturn !== null &&
    stats.avgReturn > 0 &&
    stats.globalProfitFactor !== null &&
    stats.globalProfitFactor > 1 &&
    stats.globalExpectancy !== null &&
    stats.globalExpectancy > 0 &&
    stats.tradeCount >= MIN_OPPORTUNITY_TEST_TRADES
  );
}

function heldoutTradeStatsByStrategy(
  base: BacktestInput,
  testWindows: RegimeCandidateWindow[],
): Record<string, TradePoolStats> {
  return Object.fromEntries(STRATEGY_REGISTRY.map((strategy) => {
    const trades = testWindows.flatMap((window) => runBacktest(sliceInput(base, window, strategy.id)).trades);
    return [strategy.id, tradePoolStats(trades)];
  }));
}

function gateDiagnosticsForWindows(
  base: BacktestInput,
  windows: RegimeCandidateWindow[],
): GateDiagnosticRow[] {
  const rows = new Map<string, GateDiagnosticRow>();
  const featuresByTs = new Map(base.features.map((feature) => [feature.ts, feature]));
  const sortedFeatures = base.features;
  const featureIndexByTs = new Map(sortedFeatures.map((feature, index) => [feature.ts, index]));

  for (const config of REFINED_STRATEGY_CONFIGS) {
    for (const gate of config.gates ?? []) {
      rows.set(`${config.id}|${gate}`, { strategyId: config.id, gate, passes: 0, fails: 0, unavailablePasses: 0 });
    }
  }

  for (const window of windows) {
    const windowFeatures = base.bars
      .filter((bar) => bar.ts >= window.startTs && bar.ts <= window.endTs)
      .map((bar) => featuresByTs.get(bar.ts))
      .filter((feature): feature is FeatureSnapshot => feature !== undefined);

    for (const current of windowFeatures) {
      const featureIndex = featureIndexByTs.get(current.ts);
      if (featureIndex === undefined) continue;
      const input = {
        current,
        previous: featureIndex > 0 ? sortedFeatures[featureIndex - 1] : undefined,
        recent: sortedFeatures.slice(Math.max(0, featureIndex - 50), featureIndex + 1),
        daily: latestClosedDailyFor(base.dailyFeatures, current),
        regime: latestRegimeAtOrBefore(base.regimes, current.ts),
      };

      for (const config of REFINED_STRATEGY_CONFIGS) {
        const baseSignal = config.baseStrategy.evaluate(input);
        if (!baseSignal) continue;
        const { regime } = input;
        if (config.allowedRegimes && (!regime || !config.allowedRegimes.includes(regime.regime))) continue;
        if (regime && config.blockedRegimes?.includes(regime.regime)) continue;
        if (config.minRegimeReliability !== undefined && (!regime || regime.reliability < config.minRegimeReliability)) continue;

        for (const gate of config.gates ?? []) {
          const key = `${config.id}|${gate}`;
          const row = rows.get(key);
          if (!row) continue;
          const result = GATE_EVALUATORS[gate]({ input, signal: baseSignal });
          if (result.passed) {
            row.passes++;
            if (result.reason.toLowerCase().includes("unavailable")) row.unavailablePasses++;
          } else {
            row.fails++;
          }
        }
      }
    }
  }

  return [...rows.values()];
}

function opportunityFinalVerdict(candidate: OpportunityCandidateValidation, foldsValidated: number, totalFolds: number): string {
  if (candidate.test.samples === 0 || candidate.test.tradeCount < MIN_OPPORTUNITY_TEST_TRADES) return "NEEDS MORE DATA";
  if (candidate.testPass && totalFolds > 0 && foldsValidated === totalFolds) return "VALIDATED";
  if (candidate.testPass || foldsValidated > 0) return "NEEDS MORE DATA";
  return "NOT VALIDATED";
}

function opportunityCandidatesForWindows(
  symbol: string,
  base: BacktestInput,
  trainWindows: RegimeCandidateWindow[],
  testWindows: RegimeCandidateWindow[],
): OpportunityCandidateValidation[] {
  const strategyIds = STRATEGY_REGISTRY.map((strategy) => strategy.id);
  const candidates: OpportunityCandidateValidation[] = [];
  for (const regime of REQUIRED_REGIMES) {
    for (const strategyId of strategyIds) {
      const train = opportunityPeriodStats(base, trainWindows, regime, strategyId);
      const test = opportunityPeriodStats(base, testWindows, regime, strategyId);
      candidates.push({
        symbol,
        regime,
        strategyId,
        train,
        test,
        testPass: opportunityCandidatePass(test),
      });
    }
  }
  return candidates;
}

function computeOpportunityWalkForward(
  symbol: string,
  base: BacktestInput,
  selectedWindows: RegimeCandidateWindow[],
): OpportunityWalkForwardData | null {
  const sorted = [...selectedWindows].sort((a, b) => a.startTs.localeCompare(b.startTs));
  if (sorted.length < 10) return null;

  const splitIndex = Math.floor(sorted.length * 0.7);
  const trainWindows = sorted.slice(0, splitIndex);
  const testWindows = sorted.slice(splitIndex);
  const candidates = opportunityCandidatesForWindows(symbol, base, trainWindows, testWindows);
  const rollingBoundaries: Array<{ trainEnd: number; testEnd: number }> = [
    { trainEnd: Math.floor(sorted.length * 0.4), testEnd: Math.floor(sorted.length * 0.6) },
    { trainEnd: Math.floor(sorted.length * 0.6), testEnd: Math.floor(sorted.length * 0.8) },
    { trainEnd: Math.floor(sorted.length * 0.8), testEnd: sorted.length },
  ].filter((boundary) => boundary.trainEnd > 0 && boundary.testEnd > boundary.trainEnd);

  const rollingFolds = rollingBoundaries.map((boundary) => ({
    trainEnd: boundary.trainEnd,
    testEnd: boundary.testEnd,
    candidates: opportunityCandidatesForWindows(
      symbol,
      base,
      sorted.slice(0, boundary.trainEnd),
      sorted.slice(boundary.trainEnd, boundary.testEnd),
    ),
  }));

  return { trainWindows, testWindows, candidates, rollingFolds };
}

function routerConfigComparisonSection(
  allRouterStats: FullStats[],
  staticFull: FullStats[],
  portfolioFull: FullStats[],
  experimentalConfigs: RegimeStrategyRouterConfig[],
): string[] {
  const bestByReturn = [...staticFull].sort((a, b) => (b.avgReturn ?? Number.NEGATIVE_INFINITY) - (a.avgReturn ?? Number.NEGATIVE_INFINITY))[0];
  const bestByRtDD = [...staticFull].sort((a, b) => (b.avgReturnToDrawdown ?? Number.NEGATIVE_INFINITY) - (a.avgReturnToDrawdown ?? Number.NEGATIVE_INFINITY))[0];
  const equalWeight = portfolioFull.find((p) => p.label === "equal_weight");
  const regimeWeight = portfolioFull.find((p) => p.label === "regime_weight");

  const contestants: Array<[string, FullStats]> = allRouterStats.map((s) => [s.label, s]);
  const metricRows: string[][] = [
    ["avg return (%)", ...contestants.map(([, s]) => fmt(s.avgReturn))],
    ["median return (%)", ...contestants.map(([, s]) => fmt(s.medianReturn))],
    ["max drawdown (%)", ...contestants.map(([, s]) => fmt(s.maxDrawdown))],
    ["avg drawdown (%)", ...contestants.map(([, s]) => fmt(s.avgDrawdown))],
    ["global PF", ...contestants.map(([, s]) => fmt(s.globalProfitFactor))],
    ["avg PF", ...contestants.map(([, s]) => fmt(s.avgProfitFactor))],
    ["global expectancy ($)", ...contestants.map(([, s]) => fmt(s.globalExpectancy, 4))],
    ["avg expectancy ($)", ...contestants.map(([, s]) => fmt(s.avgExpectancy, 4))],
    ["exposure (%)", ...contestants.map(([, s]) => fmt(s.avgExposure))],
    ["trade count", ...contestants.map(([, s]) => String(s.tradeCount))],
    ["no-trade windows", ...contestants.map(([, s]) => String(s.noTradeWindows))],
    ["ret/DD", ...contestants.map(([, s]) => fmt(s.avgReturnToDrawdown))],
    ["verdict", ...allRouterStats.map((s) => (routerBeatsAll(s, staticFull, portfolioFull) ? "VALIDATED" : "NOT VALIDATED"))],
  ];

  // Regime map summary rows: default A6 router + 5 experimental
  const allConfigs = [DEFAULT_A6_REGIME_ROUTER_CONFIG, ...experimentalConfigs];
  const regimeMapRows = allConfigs.map((config) => [
    config.id,
    ...REQUIRED_REGIMES.map((r) => {
      const strategies = config.regimeStrategyMap[r] ?? [];
      return strategies.length === 0 ? "—" : strategies.join("+");
    }),
  ]);

  return [
    "#### Router Configuration Comparison (In-Sample Discovery)",
    "",
    "IN-SAMPLE: router maps are derived from the same primary-config windows they are evaluated on, so these results are hypothesis discovery, not validation. See Walk-Forward Router Validation below for out-of-sample evidence. " +
    "Five experimental router configurations evaluated against the default A6 router on the same primary-config windows. " +
    "conservative_router trades only if the regime's top strategy has avgReturn > 0 AND avgPF > 1. " +
    "momentum_only_router uses momentum_continuation for every regime. " +
    "top_by_regime_return_router picks the highest-avgReturn strategy per regime from the multi-window aggregates. " +
    "top_by_regime_retdd_router picks the best ret/DD strategy per regime (no trade if no strategy has ret/DD > 0). " +
    "no_trade_in_bad_regimes_router uses the default A6 map but blanks any regime where the default router had negative avg return.",
    "",
    `Verdict benchmarks: best static by avg return = **${bestByReturn?.label ?? "n/a"}** (${fmt(bestByReturn?.avgReturn)}%), ` +
    `best static by ret/DD = **${bestByRtDD?.label ?? "n/a"}** (${fmt(bestByRtDD?.avgReturnToDrawdown)}), ` +
    `equal_weight avg ret = ${fmt(equalWeight?.avgReturn)}%, regime_weight avg ret = ${fmt(regimeWeight?.avgReturn)}%.`,
    "",
    table(
      ["metric", ...contestants.map(([label]) => label)],
      metricRows,
    ),
    "",
    "Regime strategy maps (strategy abbreviations: be=breakout_expansion, mc=momentum_continuation, mrb=mean_reversion_bounce, tp=trend_pullback; — = no trade):",
    "",
    table(
      ["router", ...REQUIRED_REGIMES],
      regimeMapRows.map((row) => [
        row[0],
        ...row.slice(1).map((cell) =>
          cell
            .replace(/breakout_expansion/g, "be")
            .replace(/momentum_continuation/g, "mc")
            .replace(/mean_reversion_bounce/g, "mrb")
            .replace(/trend_pullback/g, "tp"),
        ),
      ]),
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
    "#### Validation Configuration Comparison",
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

interface WalkForwardFoldResult {
  config: RegimeStrategyRouterConfig;
  train: FullStats;
  test: FullStats;
  testVerdict: boolean;
}

// Derives router maps from train windows ONLY, then evaluates the fixed maps on both
// train and test windows. Verdict compares each router's test stats against test-window
// benchmarks (best static by return, best static by ret/DD, equal-weight, regime-weight).
function runWalkForwardFold(
  base: BacktestInput,
  trainWindows: RegimeCandidateWindow[],
  testWindows: RegimeCandidateWindow[],
): WalkForwardFoldResult[] {
  const trainAggregates = computeAggregatesForWindows(base, trainWindows);
  const trainDefaultAudit = routerMetricAudit(base, trainWindows);
  const trainConfigs = buildExperimentalRouterConfigs(trainAggregates, trainDefaultAudit);
  const allConfigs: RegimeStrategyRouterConfig[] = [DEFAULT_A6_REGIME_ROUTER_CONFIG, ...trainConfigs];

  const testStatic = staticStrategyFullStats(base, testWindows);
  const testPortfolio = portfolioComparisonStats(base, testWindows);

  return allConfigs.map((config) => {
    const train = routerFullStatsForConfig(base, trainWindows, config);
    const test = routerFullStatsForConfig(base, testWindows, config);
    const testVerdict = routerBeatsAll(test, testStatic, testPortfolio);
    return { config, train, test, testVerdict };
  });
}

function regimeCoverageString(windows: RegimeCandidateWindow[]): string {
  return REQUIRED_REGIMES.map((r) => windows.filter((w) => w.regime === r).length).join("/");
}

function periodMetricTable(
  entries: Array<{ label: string; stats: FullStats }>,
  verdicts?: boolean[],
): string {
  const rows: string[][] = [
    ["avg return (%)", ...entries.map((e) => fmt(e.stats.avgReturn))],
    ["median return (%)", ...entries.map((e) => fmt(e.stats.medianReturn))],
    ["max drawdown (%)", ...entries.map((e) => fmt(e.stats.maxDrawdown))],
    ["global PF", ...entries.map((e) => fmt(e.stats.globalProfitFactor))],
    ["global expectancy ($)", ...entries.map((e) => fmt(e.stats.globalExpectancy, 4))],
    ["trade count", ...entries.map((e) => String(e.stats.tradeCount))],
    ["no-trade windows", ...entries.map((e) => String(e.stats.noTradeWindows))],
    ["ret/DD", ...entries.map((e) => fmt(e.stats.avgReturnToDrawdown))],
  ];
  if (verdicts) {
    rows.push(["verdict vs benchmarks", ...verdicts.map((v) => (v ? "VALIDATED" : "NOT VALIDATED"))]);
  }
  return table(["metric", ...entries.map((e) => e.label)], rows);
}

interface WalkForwardData {
  trainWindows: RegimeCandidateWindow[];
  testWindows: RegimeCandidateWindow[];
  primaryFold: WalkForwardFoldResult[];
  rollingFolds: WalkForwardFoldResult[][];
  rollingBoundaries: Array<{ trainEnd: number; testEnd: number }>;
}

function computeWalkForward(base: BacktestInput, selectedWindows: RegimeCandidateWindow[]): WalkForwardData | null {
  const sorted = [...selectedWindows].sort((a, b) => a.startTs.localeCompare(b.startTs));
  if (sorted.length < 10) return null;

  const splitIndex = Math.floor(sorted.length * 0.7);
  const trainWindows = sorted.slice(0, splitIndex);
  const testWindows = sorted.slice(splitIndex);
  const primaryFold = runWalkForwardFold(base, trainWindows, testWindows);

  const rollingBoundaries: Array<{ trainEnd: number; testEnd: number }> = [
    { trainEnd: Math.floor(sorted.length * 0.4), testEnd: Math.floor(sorted.length * 0.6) },
    { trainEnd: Math.floor(sorted.length * 0.6), testEnd: Math.floor(sorted.length * 0.8) },
    { trainEnd: Math.floor(sorted.length * 0.8), testEnd: sorted.length },
  ].filter((b) => b.trainEnd > 0 && b.testEnd > b.trainEnd);
  const rollingFolds = rollingBoundaries.map((b) =>
    runWalkForwardFold(base, sorted.slice(0, b.trainEnd), sorted.slice(b.trainEnd, b.testEnd)),
  );

  return { trainWindows, testWindows, primaryFold, rollingFolds, rollingBoundaries };
}

function walkForwardRouterSection(data: WalkForwardData | null): string[] {
  if (!data) {
    return [
      "#### Walk-Forward Router Validation",
      "",
      "Fewer than 10 selected windows are available; at least 10 are needed for a meaningful chronological train/test split. Walk-forward validation skipped.",
      "",
    ];
  }

  const { trainWindows, testWindows, primaryFold: fold, rollingFolds, rollingBoundaries } = data;

  const trainEntries = fold.map((f) => ({ label: f.config.id, stats: f.train }));
  const testEntries = fold.map((f) => ({ label: f.config.id, stats: f.test }));
  const testVerdicts = fold.map((f) => f.testVerdict);

  // Train-derived regime maps (may differ from in-sample maps because they use train data only)
  const mapRows = fold.map((f) => [
    f.config.id,
    ...REQUIRED_REGIMES.map((r) => {
      const strategies = f.config.regimeStrategyMap[r] ?? [];
      return strategies.length === 0
        ? "—"
        : strategies
            .join("+")
            .replace(/breakout_expansion/g, "be")
            .replace(/momentum_continuation/g, "mc")
            .replace(/mean_reversion_bounce/g, "mrb")
            .replace(/trend_pullback/g, "tp");
    }),
  ]);

  const routerOrder = fold.map((f) => f.config.id);
  const rollingRows = routerOrder.map((id, idx) => {
    const perFold = rollingFolds.map((rf) => rf[idx]);
    const validatedCount = perFold.filter((r) => r.testVerdict).length;
    return [
      id,
      ...perFold.map((r) => fmt(r.test.avgReturn)),
      ...perFold.map((r) => (r.testVerdict ? "Y" : "N")),
      `${validatedCount}/${rollingFolds.length}`,
    ];
  });

  return [
    "#### Walk-Forward Router Validation",
    "",
    "OUT-OF-SAMPLE: router maps are derived from train windows only, then the fixed maps are scored on held-out test windows. This is the honest test of whether the in-sample router improvements survive. Windows are split chronologically by start time (no shuffling). Verdict compares each router's test-period stats against test-period benchmarks (best static by avg return, best static by ret/DD, equal-weight, regime-weight); VALIDATED requires beating all four.",
    "",
    `Primary 70/30 split: train = ${trainWindows.length} windows (regime coverage TU/TD/HV/LV/NS/CH = ${regimeCoverageString(trainWindows)}), test = ${testWindows.length} windows (coverage = ${regimeCoverageString(testWindows)}).`,
    "",
    "Train period (in-sample; maps fitted here):",
    "",
    periodMetricTable(trainEntries),
    "",
    "Test period (out-of-sample; maps frozen from train):",
    "",
    periodMetricTable(testEntries, testVerdicts),
    "",
    "Train-derived regime maps (be=breakout_expansion, mc=momentum_continuation, mrb=mean_reversion_bounce, tp=trend_pullback; — = no trade):",
    "",
    table(["router", ...REQUIRED_REGIMES], mapRows),
    "",
    `Rolling expanding-window folds (${rollingFolds.length} folds; each re-derives maps from its train prefix and scores the next chronological slice). Columns: test avg return % per fold, then test verdict per fold (Y/N), then folds validated.`,
    "",
    table(
      [
        "router",
        ...rollingBoundaries.map((_, i) => `f${i + 1} ret%`),
        ...rollingBoundaries.map((_, i) => `f${i + 1} ok`),
        "validated",
      ],
      rollingRows,
    ),
    "",
  ];
}

interface WalkForwardSummary {
  bestRouterLabel: string;
  bestRouterTestAvgReturn: number | null;
  bestRouterTestGlobalPF: number | null;
  bestRouterTestGlobalExpectancy: number | null;
  bestRouterTestVerdict: boolean;
  foldsValidated: number;
  totalFolds: number;
  anyRouterTestValidated: boolean;
  finalVerdict: string;
}

interface RouterAuditSummary {
  avgReturn: number | null;
  globalProfitFactor: number | null;
  globalExpectancy: number | null;
}

interface PortfolioReturnSummary {
  equalWeightAvgReturn: number | null;
  regimeWeightAvgReturn: number | null;
}

interface AssetSummary {
  symbol: string;
  exchange: Exchange;
  assetType: string;
  regimeSourceLabel: string;
  dataCoverage: {
    startTs: string | null;
    endTs: string | null;
    bars: number;
    executableBars: number;
    features: number;
    featureCoveragePct: number | null;
    dailyFeatures: number;
    regimes: number;
    regimeCoveragePct: number | null;
  };
  selectedWindows: number;
  windowsByRegime: Record<RegimeLabel, number>;
  medianPurity: number | null;
  avgPurity: number | null;
  routerAuditSummary: RouterAuditSummary;
  portfolioReturnSummary: PortfolioReturnSummary;
  bestStaticByReturn: { label: string; value: number | null };
  bestStaticByRtDD: { label: string; value: number | null };
  strategyFullStats: FullStats[];
  regimeStrategyStats: RegimeStrategyStat[];
  heldoutTradeStatsByStrategy: Record<string, TradePoolStats>;
  gateDiagnostics: GateDiagnosticRow[];
  walkForward: WalkForwardSummary | null;
  opportunityWalkForward: OpportunityWalkForwardData | null;
  riskOverlay: RiskOverlayReportSummary | null;
}

// Conservative final verdict combining the 70/30 test result with rolling-fold robustness.
function finalRouterVerdict(testVerdict: boolean, foldsValidated: number, totalFolds: number): string {
  if (testVerdict && totalFolds > 0 && foldsValidated === totalFolds) return "VALIDATED";
  if (testVerdict || foldsValidated >= 1) return "NEEDS MORE DATA";
  return "NOT VALIDATED";
}

function summarizeWalkForward(data: WalkForwardData | null): WalkForwardSummary | null {
  if (!data) return null;
  const { primaryFold, rollingFolds } = data;
  const totalFolds = rollingFolds.length;
  const validated = primaryFold.filter((f) => f.testVerdict);
  const pool = validated.length > 0 ? validated : primaryFold;
  const best = pool.reduce((b, c) =>
    (c.test.avgReturn ?? Number.NEGATIVE_INFINITY) > (b.test.avgReturn ?? Number.NEGATIVE_INFINITY) ? c : b,
  );
  const foldsValidated = rollingFolds.reduce((n, fold) => {
    const entry = fold.find((f) => f.config.id === best.config.id);
    return n + (entry?.testVerdict ? 1 : 0);
  }, 0);
  return {
    bestRouterLabel: best.config.id,
    bestRouterTestAvgReturn: best.test.avgReturn,
    bestRouterTestGlobalPF: best.test.globalProfitFactor,
    bestRouterTestGlobalExpectancy: best.test.globalExpectancy,
    bestRouterTestVerdict: best.testVerdict,
    foldsValidated,
    totalFolds,
    anyRouterTestValidated: validated.length > 0,
    finalVerdict: finalRouterVerdict(best.testVerdict, foldsValidated, totalFolds),
  };
}

function topRiskBlockReasons(counts: Record<string, number>): string {
  const reasons = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([reason, count]) => `${reason} (${count})`);
  return reasons.length > 0 ? reasons.join(", ") : "none";
}

function riskOverlaySimulationSection(summaries: AssetSummary[]): string[] {
  const enabled = summaries.filter(
    (summary): summary is AssetSummary & { riskOverlay: RiskOverlayReportSummary } => summary.riskOverlay !== null,
  );
  const header = [
    "## Risk Overlay Simulation",
    "",
    "SIMULATED RISK OVERLAY ONLY \u2014 NOT PAPER TRADING OR LIVE EXECUTION",
    "",
  ];
  if (enabled.length === 0) {
    return [...header, "Risk overlay was not enabled for this run.", ""];
  }

  return [
    ...header,
    "Raw and risk-adjusted values below use the primary validation windows and the first registered strategy. Return, profit factor, and expectancy are averages across those windows; max drawdown is the worst window.",
    "",
    table(
      [
        "asset",
        "strategy",
        "windows",
        "raw trades",
        "risk trades",
        "blocked",
        "top blocked reasons",
        "raw max DD",
        "risk max DD",
        "raw avg return",
        "risk avg return",
        "raw avg PF",
        "risk avg PF",
        "raw avg expectancy",
        "risk avg expectancy",
      ],
      enabled.map((summary) => {
        const overlay = summary.riskOverlay;
        return [
          summary.symbol,
          overlay.strategyId,
          String(overlay.windows),
          String(overlay.rawTradeCount),
          String(overlay.riskAdjustedTradeCount),
          String(overlay.blockedTrades),
          topRiskBlockReasons(overlay.blockedByReason),
          `${fmt(overlay.rawMaxDrawdownPct)}%`,
          `${fmt(overlay.riskAdjustedMaxDrawdownPct)}%`,
          `${fmt(overlay.rawAvgReturnPct)}%`,
          `${fmt(overlay.riskAdjustedAvgReturnPct)}%`,
          fmt(overlay.rawAvgProfitFactor),
          fmt(overlay.riskAdjustedAvgProfitFactor),
          fmt(overlay.rawAvgExpectancy),
          fmt(overlay.riskAdjustedAvgExpectancy),
        ];
      }),
    ),
    "",
  ];
}

function multiAssetCoverageSection(summaries: AssetSummary[]): string[] {
  return [
    "## Multi-Asset Data Coverage",
    "",
    "Per-asset data depth and window selection at the primary config. Assets with no stored bars are reported as skipped elsewhere and omitted here.",
    "Windows by regime are ordered TREND_UP/TREND_DOWN/HIGH_VOL/LOW_VOL/NEWS_SHOCK/CHOP.",
    "",
    table(
      [
        "asset",
        "type",
        "exchange",
        "start",
        "end",
        "bars",
        "executable bars",
        "features",
        "feature coverage %",
        "daily features",
        "regimes",
        "regime coverage %",
        "regime source",
        "windows",
        "windows by regime",
        "median purity %",
        "average purity %",
      ],
      summaries.map((s) => [
        s.symbol,
        s.assetType,
        s.exchange,
        dateOnly(s.dataCoverage.startTs),
        dateOnly(s.dataCoverage.endTs),
        String(s.dataCoverage.bars),
        String(s.dataCoverage.executableBars),
        String(s.dataCoverage.features),
        pctFmt(s.dataCoverage.featureCoveragePct),
        String(s.dataCoverage.dailyFeatures),
        String(s.dataCoverage.regimes),
        pctFmt(s.dataCoverage.regimeCoveragePct),
        s.regimeSourceLabel,
        String(s.selectedWindows),
        REQUIRED_REGIMES.map((r) => String(s.windowsByRegime[r])).join("/"),
        fmt(s.medianPurity),
        fmt(s.avgPurity),
      ]),
    ),
    "",
  ];
}

function crossAssetOpportunitySection(summaries: AssetSummary[]): string[] {
  const all = summaries.flatMap((s) => s.regimeStrategyStats);
  // Only meaningful rows: at least one trade. Rank by global expectancy (primary edge signal).
  const ranked = all
    .filter((r) => r.tradeCount > 0 && r.globalExpectancy !== null)
    .sort((a, b) => (b.globalExpectancy ?? Number.NEGATIVE_INFINITY) - (a.globalExpectancy ?? Number.NEGATIVE_INFINITY));
  const topN = ranked.slice(0, 30);

  if (topN.length === 0) {
    return [
      "## Cross-Asset Opportunity Ranking",
      "",
      "No asset/regime/strategy combination produced trades across the selected windows.",
      "",
    ];
  }

  return [
    "## Cross-Asset Opportunity Ranking",
    "",
    "IN-SAMPLE HYPOTHESIS DISCOVERY ONLY.",
    "",
    "This section ranks asset/regime/strategy combinations using the selected research windows. It is useful for finding candidates to investigate, but it should not be treated as validated edge. Validation requires the Cross-Asset Opportunity Walk-Forward Validation section below. Rows are ranked by global expectancy (trade-level, pooled within each regime's windows). Global PF and global expectancy aggregate all trades; purity is the median dominantRegimePct of that regime's windows. Top 30 shown.",
    "",
    table(
      ["#", "asset", "regime", "strategy", "samples", "med purity%", "avg ret%", "global PF", "global expectancy ($)", "max DD%", "ret/DD", "trades"],
      topN.map((r, i) => [
        String(i + 1),
        r.symbol,
        r.regime,
        r.strategyId,
        String(r.samples),
        fmt(r.medianPurity),
        fmt(r.avgReturn),
        fmt(r.globalProfitFactor),
        fmt(r.globalExpectancy, 4),
        fmt(r.maxDrawdown),
        fmt(r.avgReturnToDrawdown),
        String(r.tradeCount),
      ]),
    ),
    "",
  ];
}

function trainRankedOpportunityCandidates(summaries: AssetSummary[]): OpportunityCandidateValidation[] {
  return summaries
    .flatMap((summary) => summary.opportunityWalkForward?.candidates ?? [])
    .filter((candidate) => candidate.train.tradeCount > 0 && candidate.train.globalExpectancy !== null)
    .sort((a, b) => {
      const expectancyDelta = (b.train.globalExpectancy ?? Number.NEGATIVE_INFINITY) -
        (a.train.globalExpectancy ?? Number.NEGATIVE_INFINITY);
      if (expectancyDelta !== 0) return expectancyDelta;
      return (b.train.avgReturn ?? Number.NEGATIVE_INFINITY) - (a.train.avgReturn ?? Number.NEGATIVE_INFINITY);
    });
}

function opportunityFoldValidationCounts(summaries: AssetSummary[]): { totalFolds: number; counts: Map<string, number> } {
  const totalFolds = Math.max(...summaries.map((summary) => summary.opportunityWalkForward?.rollingFolds.length ?? 0), 0);
  const counts = new Map<string, number>();
  for (let foldIndex = 0; foldIndex < totalFolds; foldIndex += 1) {
    const foldCandidates = summaries.flatMap((summary) =>
      summary.opportunityWalkForward?.rollingFolds[foldIndex]?.candidates ?? [],
    );
    const selected = foldCandidates
      .filter((candidate) => candidate.train.tradeCount > 0 && candidate.train.globalExpectancy !== null)
      .sort((a, b) =>
        (b.train.globalExpectancy ?? Number.NEGATIVE_INFINITY) -
        (a.train.globalExpectancy ?? Number.NEGATIVE_INFINITY),
      )
      .slice(0, CROSS_ASSET_OPPORTUNITY_TOP_N);
    for (const candidate of selected) {
      if (!candidate.testPass) continue;
      const key = opportunityCandidateKey(candidate);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return { totalFolds, counts };
}

function crossAssetOpportunityWalkForwardSection(summaries: AssetSummary[]): string[] {
  const ranked = trainRankedOpportunityCandidates(summaries).slice(0, CROSS_ASSET_OPPORTUNITY_TOP_N);
  const { totalFolds, counts } = opportunityFoldValidationCounts(summaries);
  const firstWalkForward = summaries.find((summary) => summary.opportunityWalkForward !== null)?.opportunityWalkForward;

  if (ranked.length === 0 || !firstWalkForward) {
    return [
      "## Cross-Asset Opportunity Walk-Forward Validation",
      "",
      "No train-ranked asset/regime/strategy candidates produced trades, so opportunity walk-forward validation was skipped.",
      "",
    ];
  }

  return [
    "## Cross-Asset Opportunity Walk-Forward Validation",
    "",
    `OUT-OF-SAMPLE: candidates are ranked using train windows only, then the same asset/regime/strategy candidate is scored on held-out test windows. Each asset uses a chronological 70/30 split by selected window start time. Candidate validation requires test avg return > 0, test global PF > 1, test global expectancy > 0, at least ${MIN_OPPORTUNITY_TEST_TRADES} held-out trades, and validation in every rolling fold where the cross-asset top ${CROSS_ASSET_OPPORTUNITY_TOP_N} is re-derived from the train prefix. Rows below are the top ${CROSS_ASSET_OPPORTUNITY_TOP_N} train-ranked candidates.`,
    "",
    `Primary split example from ${ranked[0].symbol}: train = ${firstWalkForward.trainWindows.length} windows, test = ${firstWalkForward.testWindows.length} windows. Rolling folds available: ${totalFolds}.`,
    "",
    table(
      ["#", "asset", "regime", "strategy", "train ret%", "test ret%", "train gPF", "test gPF", "train gExpect", "test gExpect", "test max DD%", "train trades", "test trades", "folds ok", "final verdict"],
      ranked.map((candidate, index) => {
        const foldsValidated = counts.get(opportunityCandidateKey(candidate)) ?? 0;
        return [
          String(index + 1),
          candidate.symbol,
          candidate.regime,
          candidate.strategyId,
          fmt(candidate.train.avgReturn),
          fmt(candidate.test.avgReturn),
          fmt(candidate.train.globalProfitFactor),
          fmt(candidate.test.globalProfitFactor),
          fmt(candidate.train.globalExpectancy, 4),
          fmt(candidate.test.globalExpectancy, 4),
          fmt(candidate.test.maxDrawdown),
          String(candidate.train.tradeCount),
          String(candidate.test.tradeCount),
          `${foldsValidated}/${totalFolds}`,
          opportunityFinalVerdict(candidate, foldsValidated, totalFolds),
        ];
      }),
    ),
    "",
  ];
}

function crossAssetValidatedCandidateSummarySection(summaries: AssetSummary[]): string[] {
  const ranked = trainRankedOpportunityCandidates(summaries).slice(0, CROSS_ASSET_OPPORTUNITY_TOP_N);
  const { totalFolds, counts } = opportunityFoldValidationCounts(summaries);

  if (ranked.length === 0) {
    return [
      "## Cross-Asset Validated Candidate Summary",
      "",
      "No candidates had enough train-period signal to summarize.",
      "",
    ];
  }

  const rows = ranked
    .map((candidate) => {
      const foldsValidated = counts.get(opportunityCandidateKey(candidate)) ?? 0;
      return {
        candidate,
        foldsValidated,
        verdict: opportunityFinalVerdict(candidate, foldsValidated, totalFolds),
      };
    })
    .sort((a, b) => {
      const order = (verdict: string) => verdict === "VALIDATED" ? 0 : verdict === "NEEDS MORE DATA" ? 1 : 2;
      const verdictDelta = order(a.verdict) - order(b.verdict);
      if (verdictDelta !== 0) return verdictDelta;
      return (b.candidate.test.avgReturn ?? Number.NEGATIVE_INFINITY) -
        (a.candidate.test.avgReturn ?? Number.NEGATIVE_INFINITY);
    });

  return [
    "## Cross-Asset Validated Candidate Summary",
    "",
    "This summary is intentionally conservative. VALIDATED means the candidate passed the held-out 70/30 test and every rolling expanding-window fold. NEEDS MORE DATA means some out-of-sample evidence exists but the full strict standard was not met.",
    "",
    table(
      ["asset", "regime", "strategy", "test return", "test global PF", "test expectancy", "test max drawdown", "test trades", "folds validated", "final verdict"],
      rows.map(({ candidate, foldsValidated, verdict }) => [
        candidate.symbol,
        candidate.regime,
        candidate.strategyId,
        fmt(candidate.test.avgReturn),
        fmt(candidate.test.globalProfitFactor),
        fmt(candidate.test.globalExpectancy, 4),
        fmt(candidate.test.maxDrawdown),
        String(candidate.test.tradeCount),
        `${foldsValidated}/${totalFolds}`,
        verdict,
      ]),
    ),
    "",
  ];
}

function momentumRefinedFailureReason(candidate: OpportunityCandidateValidation, foldsValidated: number, totalFolds: number): string {
  const reasons: string[] = [];
  if (candidate.test.avgReturn === null || candidate.test.avgReturn <= 0) reasons.push("test return not positive");
  if (candidate.test.globalProfitFactor === null || candidate.test.globalProfitFactor <= 1) reasons.push("test PF <= 1 or unavailable");
  if (candidate.test.globalExpectancy === null || candidate.test.globalExpectancy <= 0) reasons.push("test expectancy not positive");
  if (candidate.test.tradeCount < MIN_OPPORTUNITY_TEST_TRADES) {
    reasons.push(`test trades ${candidate.test.tradeCount} < ${MIN_OPPORTUNITY_TEST_TRADES}`);
  }
  if (foldsValidated < totalFolds) reasons.push(`rolling validation failed (${foldsValidated}/${totalFolds})`);
  return reasons.join("; ") || "none";
}

function momentumRefinedFinalVerdict(candidate: OpportunityCandidateValidation, foldsValidated: number, totalFolds: number): string {
  return candidate.testPass && totalFolds > 0 && foldsValidated === totalFolds ? "VALIDATED" : "NOT VALIDATED";
}

function momentumRefinedTestPassBreakdownSection(summaries: AssetSummary[]): string[] {
  const { totalFolds, counts } = opportunityFoldValidationCounts(summaries);
  const rows = summaries
    .flatMap((summary) => summary.opportunityWalkForward?.candidates ?? [])
    .filter((candidate) =>
      candidate.strategyId === "momentum_continuation_refined_v1" &&
      candidate.train.tradeCount > 0 &&
      candidate.train.globalExpectancy !== null &&
      candidate.testPass,
    )
    .map((candidate) => {
      const foldsValidated = counts.get(opportunityCandidateKey(candidate)) ?? 0;
      return { candidate, foldsValidated };
    })
    .sort((a, b) => (b.candidate.test.avgReturn ?? Number.NEGATIVE_INFINITY) - (a.candidate.test.avgReturn ?? Number.NEGATIVE_INFINITY));

  return [
    "### Momentum Refined Test-Pass Breakdown",
    "",
    `momentum_continuation_refined_v1 remains **NOT VALIDATED**. These rows passed the held-out 70/30 test gates but did not pass the full rolling-validation requirement, so none are promoted to validated edge or router defaults.`,
    "",
    table(
      ["asset", "regime", "train return", "test return", "test global PF", "test expectancy", "test trades", "folds validated", "final verdict", "failure reason"],
      rows.length > 0
        ? rows.map(({ candidate, foldsValidated }) => [
            candidate.symbol,
            candidate.regime,
            fmt(candidate.train.avgReturn),
            fmt(candidate.test.avgReturn),
            fmt(candidate.test.globalProfitFactor),
            fmt(candidate.test.globalExpectancy, 4),
            String(candidate.test.tradeCount),
            `${foldsValidated}/${totalFolds}`,
            momentumRefinedFinalVerdict(candidate, foldsValidated, totalFolds),
            momentumRefinedFailureReason(candidate, foldsValidated, totalFolds),
          ])
        : [["none", "n/a", "n/a", "n/a", "n/a", "n/a", "n/a", `0/${totalFolds}`, "NOT VALIDATED", "no held-out test-pass candidates"]],
    ),
    "",
  ];
}

function aggregateStrategyStats(summaries: AssetSummary[], strategyId: string): FullStats | null {
  const rows = summaries
    .map((summary) => summary.strategyFullStats.find((stats) => stats.label === strategyId))
    .filter((stats): stats is FullStats => stats !== undefined);
  if (rows.length === 0) return null;
  return {
    label: strategyId,
    samples: rows.reduce((sum, row) => sum + row.samples, 0),
    avgReturn: avg(rows.map((row) => row.avgReturn).filter((value): value is number => value !== null)),
    medianReturn: avg(rows.map((row) => row.medianReturn).filter((value): value is number => value !== null)),
    maxDrawdown: rows
      .map((row) => row.maxDrawdown)
      .filter((value): value is number => value !== null)
      .reduce((max, value) => Math.max(max, value), 0),
    avgDrawdown: avg(rows.map((row) => row.avgDrawdown).filter((value): value is number => value !== null)),
    globalProfitFactor: avg(rows.map((row) => row.globalProfitFactor).filter((value): value is number => value !== null)),
    avgProfitFactor: avg(rows.map((row) => row.avgProfitFactor).filter((value): value is number => value !== null)),
    globalExpectancy: avg(rows.map((row) => row.globalExpectancy).filter((value): value is number => value !== null)),
    avgExpectancy: avg(rows.map((row) => row.avgExpectancy).filter((value): value is number => value !== null)),
    avgExposure: avg(rows.map((row) => row.avgExposure).filter((value): value is number => value !== null)),
    tradeCount: rows.reduce((sum, row) => sum + row.tradeCount, 0),
    losingTradeCount: rows.reduce((sum, row) => sum + row.losingTradeCount, 0),
    stopLossExitCount: rows.reduce((sum, row) => sum + row.stopLossExitCount, 0),
    noTradeWindows: rows.reduce((sum, row) => sum + row.noTradeWindows, 0),
    avgReturnToDrawdown: avg(rows.map((row) => row.avgReturnToDrawdown).filter((value): value is number => value !== null)),
  };
}

function strategyCandidateSurvival(
  summaries: AssetSummary[],
  strategyId: string,
): { eligible: number; testPass: number; validated: number; needsMoreData: number; notValidated: number } {
  const { totalFolds, counts } = opportunityFoldValidationCounts(summaries);
  const candidates = summaries
    .flatMap((summary) => summary.opportunityWalkForward?.candidates ?? [])
    .filter((candidate) =>
      candidate.strategyId === strategyId &&
      candidate.train.tradeCount > 0 &&
      candidate.train.globalExpectancy !== null,
    );
  const verdicts = candidates.map((candidate) => {
    const foldsValidated = counts.get(opportunityCandidateKey(candidate)) ?? 0;
    return {
      testPass: candidate.testPass,
      verdict: opportunityFinalVerdict(candidate, foldsValidated, totalFolds),
    };
  });
  return {
    eligible: candidates.length,
    testPass: verdicts.filter((entry) => entry.testPass).length,
    validated: verdicts.filter((entry) => entry.verdict === "VALIDATED").length,
    needsMoreData: verdicts.filter((entry) => entry.verdict === "NEEDS MORE DATA").length,
    notValidated: verdicts.filter((entry) => entry.verdict === "NOT VALIDATED").length,
  };
}

function deltaFmt(refined: number | null | undefined, base: number | null | undefined, digits = 2): string {
  if (typeof refined !== "number" || typeof base !== "number") return "n/a";
  const delta = refined - base;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(digits)}`;
}

function tradeReduction(baseTrades: number | undefined, refinedTrades: number | undefined): string {
  const base = baseTrades ?? 0;
  const refined = refinedTrades ?? 0;
  if (base === 0) return refined === 0 ? "0 (n/a)" : `${base - refined} (n/a)`;
  const reduction = base - refined;
  return `${reduction} (${fmt(reduction / base * 100)}%)`;
}

function tradeReductionCount(baseTrades: number | undefined, refinedTrades: number | undefined): string {
  return String((baseTrades ?? 0) - (refinedTrades ?? 0));
}

function tradeReductionPct(baseTrades: number | undefined, refinedTrades: number | undefined): string {
  const base = baseTrades ?? 0;
  if (base === 0) return "n/a";
  return pctFmt(((base - (refinedTrades ?? 0)) / base) * 100);
}

function countReduction(baseCount: number | undefined, refinedCount: number | undefined): string {
  const base = baseCount ?? 0;
  const refined = refinedCount ?? 0;
  if (base === 0) return refined === 0 ? "0 (n/a)" : `${base - refined} (n/a)`;
  const reduction = base - refined;
  return `${reduction} (${fmt(reduction / base * 100)}%)`;
}

function candidateStatsForStrategy(
  candidates: OpportunityCandidateValidation[],
  strategyId: string,
  period: "train" | "test",
): OpportunityCandidatePeriodStats {
  const rows = candidates
    .filter((candidate) => candidate.strategyId === strategyId)
    .map((candidate) => candidate[period]);
  const returns = rows.map((row) => row.avgReturn).filter((value): value is number => value !== null);
  const pfs = rows.map((row) => row.globalProfitFactor).filter((value): value is number => value !== null);
  const expectancies = rows.map((row) => row.globalExpectancy).filter((value): value is number => value !== null);
  const drawdowns = rows.map((row) => row.maxDrawdown).filter((value): value is number => value !== null);
  return {
    samples: rows.reduce((sum, row) => sum + row.samples, 0),
    avgReturn: avg(returns),
    globalProfitFactor: avg(pfs),
    globalExpectancy: avg(expectancies),
    maxDrawdown: drawdowns.length === 0 ? null : Math.max(...drawdowns),
    tradeCount: rows.reduce((sum, row) => sum + row.tradeCount, 0),
  };
}

function statsImprove(
  refined: number | null,
  base: number | null,
  direction: "higher" | "lowerOrEqual",
): boolean {
  if (refined === null || base === null) return false;
  return direction === "higher" ? refined > base : refined <= base;
}

function drawdownWorsenedMaterially(refined: number | null, base: number | null): boolean {
  if (refined === null || base === null) return false;
  return refined > base + Math.max(0.25, Math.abs(base) * 0.1);
}

function refinementRollingFoldCounts(
  summaries: AssetSummary[],
  baseStrategyId: string,
  refinedStrategyId: string,
): RefinementFoldCounts {
  let validated = 0;
  let comparable = 0;
  let missingBase = 0;
  let missingRefined = 0;
  for (const summary of summaries) {
    for (const fold of summary.opportunityWalkForward?.rollingFolds ?? []) {
      for (const regime of REQUIRED_REGIMES) {
        const base = fold.candidates.find((candidate) => candidate.regime === regime && candidate.strategyId === baseStrategyId);
        const refined = fold.candidates.find((candidate) => candidate.regime === regime && candidate.strategyId === refinedStrategyId);
        const hasBase = !!base && base.test.samples > 0;
        const hasRefined = !!refined && refined.test.samples > 0;
        if (!hasBase) missingBase++;
        if (!hasRefined) missingRefined++;
        if (!hasBase || !hasRefined || !base || !refined) continue;
        comparable++;
        const foldValidated =
          statsImprove(refined.test.avgReturn, base.test.avgReturn, "higher") &&
          statsImprove(refined.test.globalProfitFactor, base.test.globalProfitFactor, "higher") &&
          statsImprove(refined.test.globalExpectancy, base.test.globalExpectancy, "higher") &&
          statsImprove(refined.test.maxDrawdown, base.test.maxDrawdown, "lowerOrEqual") &&
          refined.test.tradeCount >= MIN_OPPORTUNITY_TEST_TRADES;
        if (foldValidated) validated++;
      }
    }
  }
  return { validated, comparable, missingBase, missingRefined };
}

function refinementVerdict(
  baseTest: OpportunityCandidatePeriodStats,
  refinedTest: OpportunityCandidatePeriodStats,
  folds: RefinementFoldCounts,
): string {
  const returnImproves = statsImprove(refinedTest.avgReturn, baseTest.avgReturn, "higher");
  const pfImproves = statsImprove(refinedTest.globalProfitFactor, baseTest.globalProfitFactor, "higher");
  const expectancyImproves = statsImprove(refinedTest.globalExpectancy, baseTest.globalExpectancy, "higher");
  const drawdownImproves = statsImprove(refinedTest.maxDrawdown, baseTest.maxDrawdown, "lowerOrEqual");
  const sufficientTrades = refinedTest.tradeCount >= MIN_OPPORTUNITY_TEST_TRADES;
  const foldsConsistent = folds.comparable > 0 && folds.validated === folds.comparable;
  if (returnImproves && pfImproves && expectancyImproves && drawdownImproves && sufficientTrades && foldsConsistent) {
    return "VALIDATED";
  }

  const improvements = [returnImproves, pfImproves, expectancyImproves, drawdownImproves].filter(Boolean).length;
  if (
    improvements > 0 &&
    (
      !sufficientTrades ||
      (folds.comparable > 0 && folds.validated > 0 && folds.validated < folds.comparable)
    )
  ) {
    return "NEEDS MORE DATA";
  }

  if (
    !returnImproves ||
    !pfImproves ||
    !expectancyImproves ||
    drawdownWorsenedMaterially(refinedTest.maxDrawdown, baseTest.maxDrawdown) ||
    (folds.comparable > 0 && folds.validated === 0)
  ) {
    return "NOT VALIDATED";
  }

  return "NEEDS MORE DATA";
}

function pooledHeldoutStatsForStrategy(summaries: AssetSummary[], strategyId: string): TradePoolStats {
  const grossProfitTotal = summaries.reduce((sum, summary) => sum + (summary.heldoutTradeStatsByStrategy[strategyId]?.grossProfit ?? 0), 0);
  const grossLossAbsTotal = summaries.reduce((sum, summary) => sum + (summary.heldoutTradeStatsByStrategy[strategyId]?.grossLossAbs ?? 0), 0);
  const tradeCount = summaries.reduce((sum, summary) => sum + (summary.heldoutTradeStatsByStrategy[strategyId]?.tradeCount ?? 0), 0);
  const pnlTotal = summaries.reduce((sum, summary) => {
    const stats = summary.heldoutTradeStatsByStrategy[strategyId];
    return sum + (stats?.pooledExpectancy === null || stats === undefined ? 0 : stats.pooledExpectancy * stats.tradeCount);
  }, 0);
  return {
    grossProfit: grossProfitTotal,
    grossLossAbs: grossLossAbsTotal,
    pooledProfitFactor: grossLossAbsTotal === 0 ? null : grossProfitTotal / grossLossAbsTotal,
    pooledExpectancy: tradeCount === 0 ? null : pnlTotal / tradeCount,
    tradeCount,
  };
}

function refinementWarnings(
  refinedTest: OpportunityCandidatePeriodStats,
  baseTest: OpportunityCandidatePeriodStats,
  folds: RefinementFoldCounts,
): string {
  const warnings: string[] = [];
  if (refinedTest.tradeCount < MIN_OPPORTUNITY_TEST_TRADES) {
    warnings.push(`refined test trades ${refinedTest.tradeCount} < ${MIN_OPPORTUNITY_TEST_TRADES}`);
  }
  const baseTrades = baseTest.tradeCount;
  if (baseTrades > 0 && (baseTrades - refinedTest.tradeCount) / baseTrades > 0.9) {
    warnings.push("trade reduction > 90%");
  }
  if (folds.comparable === 0) warnings.push("no comparable rolling folds");
  return warnings.join("; ") || "none";
}

function aggregateGateDiagnostics(summaries: AssetSummary[]): GateDiagnosticRow[] {
  const rows = new Map<string, GateDiagnosticRow>();
  for (const summary of summaries) {
    for (const row of summary.gateDiagnostics) {
      const key = `${row.strategyId}|${row.gate}`;
      const existing = rows.get(key) ?? { strategyId: row.strategyId, gate: row.gate, passes: 0, fails: 0, unavailablePasses: 0 };
      existing.passes += row.passes;
      existing.fails += row.fails;
      existing.unavailablePasses += row.unavailablePasses;
      rows.set(key, existing);
    }
  }
  return [...rows.values()].sort((a, b) => a.strategyId.localeCompare(b.strategyId) || a.gate.localeCompare(b.gate));
}

function gateAvailabilityDiagnosticsSection(summaries: AssetSummary[]): string[] {
  const rows = aggregateGateDiagnostics(summaries);
  if (rows.length === 0) return [];
  return [
    "### Gate Availability Diagnostics",
    "",
    "Diagnostics evaluate each configured gate independently across base-strategy signal contexts that pass the refined variant's regime and reliability filters. `unavailable passes` are pass-open cases where a gate reason includes unavailable source data; they are useful for spotting indicators that are not actually constraining a variant.",
    "",
    table(
      ["strategy", "gate", "passes", "fails", "unavailable passes", "unavailable pass %"],
      rows.map((row) => {
        const attempts = row.passes + row.fails;
        const unavailablePct = row.passes === 0 ? null : row.unavailablePasses / row.passes * 100;
        return [
          row.strategyId,
          row.gate,
          String(row.passes),
          String(row.fails),
          String(row.unavailablePasses),
          attempts === 0 ? "n/a" : pctFmt(unavailablePct),
        ];
      }),
    ),
    "",
  ];
}

function strategyRefinementCandidateResultsSection(summaries: AssetSummary[]): string[] {
  if (summaries.length === 0) {
    return [
      "## Strategy Refinement Candidate Results",
      "",
      "No assets had sufficient stored data for strategy refinement candidate analysis.",
      "",
    ];
  }
  const candidates = summaries.flatMap((summary) => summary.opportunityWalkForward?.candidates ?? []);
  const rows = REFINED_STRATEGY_RULE_SUMMARIES.map((rule) => {
    const baseFull = aggregateStrategyStats(summaries, rule.baseStrategyId);
    const refinedFull = aggregateStrategyStats(summaries, rule.refinedStrategyId);
    const baseTest = candidateStatsForStrategy(candidates, rule.baseStrategyId, "test");
    const refinedTest = candidateStatsForStrategy(candidates, rule.refinedStrategyId, "test");
    const basePooled = pooledHeldoutStatsForStrategy(summaries, rule.baseStrategyId);
    const refinedPooled = pooledHeldoutStatsForStrategy(summaries, rule.refinedStrategyId);
    const folds = refinementRollingFoldCounts(summaries, rule.baseStrategyId, rule.refinedStrategyId);
    return [
      rule.baseStrategyId,
      rule.refinedStrategyId,
      rule.allowedRegimes.join(", "),
      rule.blockedRegimes.join(", "),
      fmt(baseTest.avgReturn),
      fmt(refinedTest.avgReturn),
      fmt(baseTest.globalProfitFactor),
      fmt(refinedTest.globalProfitFactor),
      fmt(baseTest.globalExpectancy, 4),
      fmt(refinedTest.globalExpectancy, 4),
      fmt(baseTest.maxDrawdown),
      fmt(refinedTest.maxDrawdown),
      String(baseTest.tradeCount),
      String(refinedTest.tradeCount),
      tradeReductionCount(baseTest.tradeCount, refinedTest.tradeCount),
      tradeReductionPct(baseTest.tradeCount, refinedTest.tradeCount),
      fmt(baseFull?.avgExposure),
      fmt(refinedFull?.avgExposure),
      fmt(basePooled.grossProfit),
      fmt(refinedPooled.grossProfit),
      fmt(basePooled.grossLossAbs),
      fmt(refinedPooled.grossLossAbs),
      fmt(basePooled.pooledProfitFactor),
      fmt(refinedPooled.pooledProfitFactor),
      fmt(basePooled.pooledExpectancy, 4),
      fmt(refinedPooled.pooledExpectancy, 4),
      String(basePooled.tradeCount),
      String(refinedPooled.tradeCount),
      String(folds.comparable),
      String(folds.missingBase),
      String(folds.missingRefined),
      String(folds.validated),
      refinementVerdict(baseTest, refinedTest, folds),
      refinementWarnings(refinedTest, baseTest, folds),
    ];
  });

  return [
    "## Strategy Refinement Candidate Results",
    "",
    "This section uses held-out 70/30 test-window candidate metrics for base-vs-refined comparison, plus rolling expanding-window fold checks. Candidate metrics are averaged across held-out asset/regime candidate rows, so they are directional research evidence, not pooled trade-level proof. Pooled held-out trade stats are included separately where trades exist. Verdicts are conservative: a variant is VALIDATED only when held-out return, profit factor, expectancy, drawdown, trade sufficiency, and all comparable rolling-fold checks beat the base strategy. These are research verdicts only.",
    "",
    table(
      ["strategy", "variant", "allowed regimes", "blocked regimes", "base avg return", "refined avg return", "base global PF", "refined global PF", "base global expectancy", "refined global expectancy", "base max drawdown", "refined max drawdown", "base trades", "refined trades", "trade reduction count", "trade reduction %", "base exposure", "refined exposure", "base gross profit", "refined gross profit", "base gross loss", "refined gross loss", "base pooled PF", "refined pooled PF", "base pooled expectancy", "refined pooled expectancy", "base pooled trades", "refined pooled trades", "comparable folds", "missing base folds", "missing refined folds", "validated folds", "verdict", "warnings"],
      rows,
    ),
    "",
  ];
}

function strategyRefinementComparisonSection(summaries: AssetSummary[]): string[] {
  if (summaries.length === 0) return [];

  const rows = REFINED_STRATEGY_PAIRS.map((pair) => {
    const base = aggregateStrategyStats(summaries, pair.baseStrategyId);
    const refined = aggregateStrategyStats(summaries, pair.refinedStrategyId);
    const baseSurvival = strategyCandidateSurvival(summaries, pair.baseStrategyId);
    const refinedSurvival = strategyCandidateSurvival(summaries, pair.refinedStrategyId);
    return [
      pair.baseStrategyId,
      pair.refinedStrategyId,
      fmt(base?.avgReturn),
      fmt(refined?.avgReturn),
      deltaFmt(refined?.avgReturn, base?.avgReturn),
      fmt(base?.medianReturn),
      fmt(refined?.medianReturn),
      fmt(base?.globalProfitFactor),
      fmt(refined?.globalProfitFactor),
      deltaFmt(refined?.globalProfitFactor, base?.globalProfitFactor),
      fmt(base?.avgProfitFactor),
      fmt(refined?.avgProfitFactor),
      fmt(base?.globalExpectancy, 4),
      fmt(refined?.globalExpectancy, 4),
      deltaFmt(refined?.globalExpectancy, base?.globalExpectancy, 4),
      fmt(base?.avgExpectancy, 4),
      fmt(refined?.avgExpectancy, 4),
      fmt(base?.maxDrawdown),
      fmt(refined?.maxDrawdown),
      deltaFmt(refined?.maxDrawdown, base?.maxDrawdown),
      String(base?.tradeCount ?? 0),
      String(refined?.tradeCount ?? 0),
      tradeReduction(base?.tradeCount, refined?.tradeCount),
      String(base?.losingTradeCount ?? 0),
      String(refined?.losingTradeCount ?? 0),
      countReduction(base?.losingTradeCount, refined?.losingTradeCount),
      String(base?.stopLossExitCount ?? 0),
      String(refined?.stopLossExitCount ?? 0),
      countReduction(base?.stopLossExitCount, refined?.stopLossExitCount),
      fmt(base?.avgExposure),
      fmt(refined?.avgExposure),
      fmt(base?.avgReturnToDrawdown),
      fmt(refined?.avgReturnToDrawdown),
      `${baseSurvival.validated}/${baseSurvival.eligible}`,
      `${refinedSurvival.validated}/${refinedSurvival.eligible}`,
      `${baseSurvival.testPass}/${baseSurvival.eligible}`,
      `${refinedSurvival.testPass}/${refinedSurvival.eligible}`,
    ];
  });

  return [
    "## Strategy Refinement Candidate Comparison",
    "",
    "Research-only refined variants are registered beside their base strategies and evaluated as separate benchmark candidates. Aggregated metrics below average per-asset full-window strategy stats across the selected crypto universe; walk-forward survival counts use the cross-asset opportunity candidate validation rules. Losing-trade and stop-loss reductions are proxy diagnostics for false-breakout filtering, not live execution labels.",
    "",
    table(
      ["base", "refined", "base ret%", "refined ret%", "ret delta", "base medRet%", "refined medRet%", "base gPF", "refined gPF", "gPF delta", "base avgPF", "refined avgPF", "base gExpect", "refined gExpect", "expect delta", "base avgExpect", "refined avgExpect", "base maxDD", "refined maxDD", "DD delta", "base trades", "refined trades", "trade reduction", "base losses", "refined losses", "loss reduction", "base stops", "refined stops", "stop reduction", "base exposure", "refined exposure", "base ret/DD", "refined ret/DD", "base validated", "refined validated", "base test pass", "refined test pass"],
      rows,
    ),
    "",
  ];
}

function crossAssetRouterValidationSection(summaries: AssetSummary[]): string[] {
  return [
    "## Cross-Asset Router Validation Summary",
    "",
    "One row per asset. 'best router' is the highest test-period avg-return router from the 70/30 walk-forward (preferring any that beat all four benchmarks). 'test verdict' = beats best-static-by-return, best-static-by-ret/DD, equal-weight, and regime-weight on the held-out test set. 'final verdict' is conservative: VALIDATED only if the best router beats all benchmarks AND validates every rolling fold; NEEDS MORE DATA if it shows partial out-of-sample edge; otherwise NOT VALIDATED.",
    "",
    table(
      ["asset", "windows", "med purity%", "best static (ret)", "best static (ret/DD)", "best router", "router test ret%", "router test gPF", "router test gExpect", "test verdict", "folds validated", "final verdict"],
      summaries.map((s) => {
        const wf = s.walkForward;
        return [
          s.symbol,
          String(s.selectedWindows),
          fmt(s.medianPurity),
          `${s.bestStaticByReturn.label} (${fmt(s.bestStaticByReturn.value)}%)`,
          `${s.bestStaticByRtDD.label} (${fmt(s.bestStaticByRtDD.value)})`,
          wf ? wf.bestRouterLabel : "n/a",
          wf ? fmt(wf.bestRouterTestAvgReturn) : "n/a",
          wf ? fmt(wf.bestRouterTestGlobalPF) : "n/a",
          wf ? fmt(wf.bestRouterTestGlobalExpectancy, 4) : "n/a",
          wf ? (wf.bestRouterTestVerdict ? "VALIDATED" : "NOT VALIDATED") : "n/a",
          wf ? `${wf.foldsValidated}/${wf.totalFolds}` : "n/a",
          wf ? wf.finalVerdict : "INSUFFICIENT WINDOWS",
        ];
      }),
    ),
    "",
  ];
}

function routerAuditSummarySection(summaries: AssetSummary[]): string[] {
  if (summaries.length === 0) {
    return [
      "## Router Audit Summary",
      "",
      "No assets had enough data for router audit summarization.",
      "",
    ];
  }

  return [
    "## Router Audit Summary",
    "",
    "Primary-window router audit metrics are in-sample diagnostics from the selected research windows. Test verdict, folds validated, and final verdict come from out-of-sample walk-forward validation. A router is not validated unless it beats best-static-by-return, best-static-by-ret/DD, equal-weight, and regime-weight benchmarks out-of-sample.",
    "",
    table(
      ["asset", "router avg return", "router global PF", "router global expectancy", "best static by return", "best static by ret/DD", "equal-weight return", "regime-weight return", "test verdict", "folds validated", "final verdict"],
      summaries.map((s) => {
        const wf = s.walkForward;
        return [
          s.symbol,
          fmt(s.routerAuditSummary.avgReturn),
          fmt(s.routerAuditSummary.globalProfitFactor),
          fmt(s.routerAuditSummary.globalExpectancy, 4),
          `${s.bestStaticByReturn.label} (${fmt(s.bestStaticByReturn.value)}%)`,
          `${s.bestStaticByRtDD.label} (${fmt(s.bestStaticByRtDD.value)})`,
          fmt(s.portfolioReturnSummary.equalWeightAvgReturn),
          fmt(s.portfolioReturnSummary.regimeWeightAvgReturn),
          wf ? (wf.bestRouterTestVerdict ? "VALIDATED" : "NOT VALIDATED") : "n/a",
          wf ? `${wf.foldsValidated}/${wf.totalFolds}` : "n/a",
          wf ? wf.finalVerdict : "INSUFFICIENT WINDOWS",
        ];
      }),
    ),
    "",
  ];
}

function rankMetric(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function compareRegimeStrategyStats(a: RegimeStrategyStat, b: RegimeStrategyStat): number {
  const expectancyDelta = rankMetric(b.globalExpectancy) - rankMetric(a.globalExpectancy);
  if (expectancyDelta !== 0) return expectancyDelta;
  const returnDelta = rankMetric(b.avgReturn) - rankMetric(a.avgReturn);
  if (returnDelta !== 0) return returnDelta;
  const pfDelta = rankMetric(b.globalProfitFactor) - rankMetric(a.globalProfitFactor);
  if (pfDelta !== 0) return pfDelta;
  return b.tradeCount - a.tradeCount;
}

function bestRegimeStrategyStat(rows: RegimeStrategyStat[]): RegimeStrategyStat | null {
  const eligible = rows.filter((row) => row.tradeCount > 0 && row.globalExpectancy !== null);
  if (eligible.length === 0) return null;
  return [...eligible].sort(compareRegimeStrategyStats)[0];
}

function strategyStatLabel(stat: RegimeStrategyStat | null): string {
  return stat?.strategyId ?? "none";
}

function bestStrategyByRegimeVerdict(
  summary: AssetSummary,
  leader: RegimeStrategyStat | null,
  counts: Map<string, number>,
  totalFolds: number,
): string {
  if (!leader) return "NO TRADE SIGNAL";
  const candidate = summary.opportunityWalkForward?.candidates.find((row) =>
    row.regime === leader.regime && row.strategyId === leader.strategyId,
  );
  if (!candidate) return "IN-SAMPLE ONLY";
  const foldsValidated = counts.get(opportunityCandidateKey(candidate)) ?? 0;
  return opportunityFinalVerdict(candidate, foldsValidated, totalFolds);
}

function bestStrategyByRegimeSummarySection(summaries: AssetSummary[]): string[] {
  if (summaries.length === 0) {
    return [
      "## Best Strategy By Regime Summary",
      "",
      "No assets had enough data for per-regime strategy summarization.",
      "",
    ];
  }

  const { totalFolds, counts } = opportunityFoldValidationCounts(summaries);
  const rows = summaries.flatMap((summary) =>
    REQUIRED_REGIMES.map((regime) => {
      const regimeStats = summary.regimeStrategyStats.filter((row) => row.regime === regime);
      const bestBase = bestRegimeStrategyStat(regimeStats.filter((row) => BASE_STRATEGY_IDS.has(row.strategyId)));
      const bestRefined = bestRegimeStrategyStat(regimeStats.filter((row) => REFINED_STRATEGY_IDS.has(row.strategyId)));
      const leaders = [bestBase, bestRefined].filter((row): row is RegimeStrategyStat => row !== null);
      const leader = leaders.length > 0 ? [...leaders].sort(compareRegimeStrategyStats)[0] : null;
      return [
        summary.symbol,
        regime,
        strategyStatLabel(bestBase),
        strategyStatLabel(bestRefined),
        fmt(leader?.avgReturn),
        fmt(leader?.globalProfitFactor),
        fmt(leader?.globalExpectancy, 4),
        String(leader?.tradeCount ?? 0),
        bestStrategyByRegimeVerdict(summary, leader, counts, totalFolds),
      ];
    }),
  );

  return [
    "## Best Strategy By Regime Summary",
    "",
    "One row per analyzed asset/regime. Best base and best refined strategies are selected from in-sample selected-window results using global expectancy, then average return, global profit factor, and trade count as tie-breakers. Metric and verdict columns describe the stronger of the best base and best refined candidates; verdicts use the existing opportunity walk-forward validation when available.",
    "",
    table(
      ["asset", "regime", "best base strategy", "best refined strategy", "avg return", "global PF", "global expectancy", "trade count", "verdict"],
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

interface InstrumentReport {
  markdown: string;
  summary: AssetSummary | null;
}

async function runInstrument(instrument: InstrumentArg): Promise<InstrumentReport> {
  backtestResultCache.clear();
  const timeframe: Timeframe = "1h";
  const bounds = process.env.START_TS && process.env.END_TS
    ? { startTs: process.env.START_TS, endTs: process.env.END_TS }
    : await fetchBounds(instrument.symbol, instrument.exchange, timeframe);
  if (!bounds) {
    const markdown = [
      `### ${instrument.symbol}`,
      "",
      `Instrument: symbol=${instrument.symbol}, exchange=${instrument.exchange}, assetType=${instrument.assetType}, dataSource=${instrument.dataSource}`,
      "",
      `${instrument.symbol} skipped — no stored ${timeframe} bars available for configured data source (${instrument.dataSource}).`,
      instrument.assetType === "EQUITY"
        ? "Equity OHLCV ingestion is not implemented yet; add an equity data source and backfill before this asset can be analyzed."
        : "Backfill this symbol (e.g. npm run backfill:crypto:bulk) then compute features and regimes before re-running.",
      "",
    ].join("\n");
    return { markdown, summary: null };
  }

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
  const experimentalConfigs = buildExperimentalRouterConfigs(validation.aggregates, routerAudit);
  const expStats = experimentalRouterStats(baseInput, validation.selectedWindows, experimentalConfigs);
  const allRouterStats = [routerFull, ...expStats];
  const walkForwardData = computeWalkForward(baseInput, validation.selectedWindows);
  const regimeStrategyStats = crossAssetRegimeStrategyStats(instrument.symbol, baseInput, validation.selectedWindows);
  const opportunityWalkForward = computeOpportunityWalkForward(instrument.symbol, baseInput, validation.selectedWindows);
  const heldoutTradeStats = heldoutTradeStatsByStrategy(baseInput, opportunityWalkForward?.testWindows ?? []);
  const gateDiagnostics = gateDiagnosticsForWindows(baseInput, validation.selectedWindows);
  const riskOverlay = summarizeRiskOverlayWindows(baseInput, validation.selectedWindows);
  const bestByReturn = [...staticFull].sort((a, b) => (b.avgReturn ?? Number.NEGATIVE_INFINITY) - (a.avgReturn ?? Number.NEGATIVE_INFINITY))[0];
  const bestByRtDD = [...staticFull].sort((a, b) => (b.avgReturnToDrawdown ?? Number.NEGATIVE_INFINITY) - (a.avgReturnToDrawdown ?? Number.NEGATIVE_INFINITY))[0];
  const equalWeightPortfolio = portfolioFull.find((row) => row.label === "equal_weight");
  const regimeWeightPortfolio = portfolioFull.find((row) => row.label === "regime_weight");
  const coverageStartTs = bars[0]?.ts ?? bounds.startTs;
  const coverageEndTs = bars[bars.length - 1]?.ts ?? bounds.endTs;
  const summary: AssetSummary = {
    symbol: instrument.symbol,
    exchange: instrument.exchange,
    assetType: instrument.assetType,
    regimeSourceLabel: sourceDisplayLabel(regimeSourceDisplay),
    dataCoverage: {
      startTs: coverageStartTs,
      endTs: coverageEndTs,
      bars: bars.length,
      executableBars: executableBars.length,
      features: features.length,
      featureCoveragePct: pctOf(features.length, bars.length),
      dailyFeatures: dailyFeatures.length,
      regimes: regimes.length,
      regimeCoveragePct: pctOf(regimes.length, bars.length),
    },
    selectedWindows: validation.selectedWindows.length,
    windowsByRegime: coverageCounts(validation.selectedWindows),
    medianPurity: primaryResult.purity.medianDominantRegimePct,
    avgPurity: primaryResult.purity.avgDominantRegimePct,
    routerAuditSummary: {
      avgReturn: routerAudit.averageReturnPct,
      globalProfitFactor: routerAudit.globalProfitFactor,
      globalExpectancy: routerAudit.globalExpectancy,
    },
    portfolioReturnSummary: {
      equalWeightAvgReturn: equalWeightPortfolio?.avgReturn ?? null,
      regimeWeightAvgReturn: regimeWeightPortfolio?.avgReturn ?? null,
    },
    bestStaticByReturn: { label: bestByReturn?.label ?? "n/a", value: bestByReturn?.avgReturn ?? null },
    bestStaticByRtDD: { label: bestByRtDD?.label ?? "n/a", value: bestByRtDD?.avgReturnToDrawdown ?? null },
    strategyFullStats: staticFull,
    regimeStrategyStats,
    heldoutTradeStatsByStrategy: heldoutTradeStats,
    gateDiagnostics,
    walkForward: summarizeWalkForward(walkForwardData),
    opportunityWalkForward,
    riskOverlay,
  };
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

  const markdown = [
    `### ${instrument.symbol}`,
    "",
    `Instrument: symbol=${instrument.symbol}, exchange=${instrument.exchange}, assetType=${instrument.assetType}, dataSource=${instrument.dataSource}`,
    `Range: ${bounds.startTs} to ${bounds.endTs}`,
    `Rows: bars=${bars.length}, executableBars=${executableBars.length}, features=${features.length}, dailyFeatures=${dailyFeatures.length}, persistedRegimes=${persistedRegimes.length}, researchRegimes=${regimes.length}`,
    `Regime source: ${sourceDisplayLabel(regimeSourceDisplay)}`,
    `Window bars: ${validation.selectedWindows[0]?.barCount ?? effectiveWindowBars} (primary config: ${primaryResult.config.label})`,
    `Requested windows per regime: ${requestedWindowsPerRegime}`,
    `Selected windows: ${validation.selectedWindows.length} (${coverage})`,
    `Purity: median=${fmt(primaryResult.purity.medianDominantRegimePct)}%, avg=${fmt(primaryResult.purity.avgDominantRegimePct)}%`,
    sourceCaution(regimeSourceDisplay) ?? "",
    warnings.length > 0 ? "" : "",
    warnings.length > 0 ? "#### Validation Warnings" : "",
    ...warnings.map((warning) => `- ${warning}`),
    "",
    "#### Multi-Window Results",
    aggregateTable(validation.aggregates),
    "",
    "#### Best Strategy By Regime",
    "",
    "Composite score is the average ordinal rank across avg return, median return, max drawdown, expectancy, profit factor, win rate, exposure, and return-to-drawdown. Lower score is better; drawdown and exposure are ranked low-to-high.",
    "",
    bestStrategyByRegimeTable(validation.aggregates),
    "",
    "#### A6 Routing Results",
    summaryTable(routing),
    "",
    ...routerMetricAuditSection(routerAudit),
    "",
    "#### Portfolio Results",
    summaryTable(portfolios),
    "",
    ...routerVsStaticSection(staticFull, routerFull, portfolioFull),
    ...routerConfigComparisonSection(allRouterStats, staticFull, portfolioFull, experimentalConfigs),
    ...walkForwardRouterSection(walkForwardData),
    ...regimePuritySection(validation.selectedWindows, minPurityPct),
    ...validationConfigComparisonSection(configResults, primaryResult.config.label),
    "#### Stability Rankings",
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

  return { markdown, summary };
}

async function main(): Promise<void> {
  const sections: string[] = [];
  const summaries: AssetSummary[] = [];
  const configuredReportPath = process.env.P5_REPORT_PATH?.trim();
  const reportPath = configuredReportPath
    ? path.resolve(process.cwd(), configuredReportPath)
    : path.join(process.cwd(), "P5_MULTI_ASSET_STRATEGY_RESEARCH_REPORT.md");
  const runTimestamp = new Date().toISOString();
  const strategyVersions = strategyVersionSummary();
  const resolution = await resolveInstruments();
  const skippedEquitySections = await skippedEquityAssetsSection();
  const { instruments } = resolution;
  for (const instrument of instruments) {
    const result = await runInstrument(instrument);
    sections.push(result.markdown);
    if (result.summary) summaries.push(result.summary);
  }

  const crossAssetSections = summaries.length > 0
    ? [
        ...multiAssetCoverageSection(summaries),
        ...crossAssetOpportunitySection(summaries),
        ...crossAssetOpportunityWalkForwardSection(summaries),
        ...crossAssetValidatedCandidateSummarySection(summaries),
        ...crossAssetRouterValidationSection(summaries),
        ...routerAuditSummarySection(summaries),
        ...bestStrategyByRegimeSummarySection(summaries),
      ]
    : [
        "## Multi-Asset Data Coverage",
        "",
        "No assets had sufficient stored data to analyze.",
        "",
        ...crossAssetOpportunitySection(summaries),
        ...crossAssetOpportunityWalkForwardSection(summaries),
        ...crossAssetValidatedCandidateSummarySection(summaries),
        ...crossAssetRouterValidationSection(summaries),
        ...routerAuditSummarySection(summaries),
        ...bestStrategyByRegimeSummarySection(summaries),
      ];

  const metadata: ReportRunMetadata = {
    branch: gitValue("rev-parse --abbrev-ref HEAD"),
    generatedFromCommit: gitValue("rev-parse HEAD"),
    committedInCommit: null,
    runTimestamp,
    reportPath: repoRelativePath(reportPath) ?? reportPath,
    logPath: repoRelativePath(process.env.P5_LOG_PATH ?? null),
    strategyVersions,
    featureVersion: FEATURE_VERSION,
    windowConfig: windowConfigText(),
    symbolsDiscovered: instruments.map((instrument) => `${instrument.symbol}@${instrument.exchange}`),
  };

  const report = [
    "# P5 Multi-Asset Strategy Research Report",
    "",
    "Generated by `scripts/runExpandedBacktestResearch.ts` (`npm run research:p5:multiasset`).",
    "",
    resolvedAssetLine(resolution, summaries),
    "The historical BTC-only report remains at `P4_EXPANDED_STRATEGY_ANALYTICS_AND_ROUTING_REPORT.md`.",
    "",
    ...executiveSummarySection(resolution, summaries),
    ...regimeSourceExplanationSection(),
    ...discoveryReadinessSection(resolution.discovery),
    ...skippedEquitySections,
    ...crossAssetSections,
    ...riskOverlaySimulationSection(summaries),
    ...strategyRecommendationSummarySection(),
    ...knownLimitationsSection(),
    ...nextActionListSection(),
    ...strategyRefinementCandidateResultsSection(summaries),
    ...strategyRefinementComparisonSection(summaries),
    ...momentumRefinedTestPassBreakdownSection(summaries),
    ...gateAvailabilityDiagnosticsSection(summaries),
    "## Per-Asset Detail",
    "",
    "Supporting run metadata, implementation context, and per-asset detail tables for the top-level research conclusions.",
    "",
    ...runMetadataSection(metadata).map((line) => line === "## Run Metadata" ? "### Run Metadata" : line),
    ...implementationSummarySection(),
    ...strategyAnalyticsSection(),
    ...architectureChangesSection(),
    ...issuesFoundSection(),
    ...sections,
  ].join("\n");

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, report);
  appendReportIndex({
    timestamp: runTimestamp,
    branch: metadata.branch,
    generatedFromCommit: metadata.generatedFromCommit,
    committedInCommit: metadata.committedInCommit,
    reportPath: metadata.reportPath,
    logPath: metadata.logPath ?? null,
    exitCode: 0,
    assetsAnalyzed: summaries.map((summary) => summary.symbol),
    strategyVersions,
    notes: process.env.P5_RUN_NOTES ?? "generated by scripts/runExpandedBacktestResearch.ts",
  });
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
