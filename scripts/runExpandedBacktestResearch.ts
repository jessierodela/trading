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
  type RegimeValidationSource,
} from "@/lib/backtest/regimeValidation";
import type { BacktestAssetType, BacktestConfig, BacktestInput, BacktestMetrics } from "@/lib/backtest/types";

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

async function fetchRegimes(symbol: string, exchange: Exchange, startTs: string, endTs: string): Promise<RegimeContext[]> {
  const pool = getPgPool();
  const { rows } = await pool.query<{ ts: Date; regime: RegimeLabel; reliability: string }>(
    `select distinct on (ts) ts, regime, reliability
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
    regimeWeights: {
      TREND_UP: { breakout_expansion: 0.6, momentum_continuation: 0.4 },
      TREND_DOWN: { momentum_continuation: 1 },
      HIGH_VOL: { mean_reversion_bounce: 0.7, trend_pullback: 0.3 },
      LOW_VOL: { mean_reversion_bounce: 1 },
      NEWS_SHOCK: { momentum_continuation: 1 },
      CHOP: { momentum_continuation: 0.5, mean_reversion_bounce: 0.5 },
    },
  };
  return [equal, custom, regime].map((portfolioConfig) => {
    const metrics = windows.map((window) => runPortfolioBacktest(
      sliceInput(base, window, `portfolio_${portfolioConfig.mode}`),
      portfolioConfig,
    ).metrics);
    return summarizeMetrics(portfolioConfig.mode, metrics);
  });
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

function featureAlignedBars(bars: Bar[], features: FeatureSnapshot[]): Bar[] {
  if (features.length === 0) return [];
  const featureTs = new Set(features.map((feature) => feature.ts));
  return bars.filter((bar) => featureTs.has(bar.ts));
}

function configuredWindowBarsFor(regimeSource: RegimeValidationSource): number {
  if (process.env.WINDOW_BARS) return Number(process.env.WINDOW_BARS);
  return regimeSource === "ohlcv_proxy" ? DEFAULT_PROXY_WINDOW_BARS : 24 * 14;
}

function effectiveWindowBarsFor(regimeSource: RegimeValidationSource, configuredWindowBars: number): number {
  if (regimeSource !== "ohlcv_proxy") return configuredWindowBars;
  return Math.max(MIN_PROXY_WINDOW_BARS, configuredWindowBars);
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
  const configuredWindowBars = configuredWindowBarsFor(regimeSource);
  const effectiveWindowBars = effectiveWindowBarsFor(regimeSource, configuredWindowBars);
  const validationOptions: RegimeValidationOptions = {
    instrument,
    baseConfig: validationBaseConfig,
    bars: executableBars,
    features,
    dailyFeatures,
    regimes,
    regimeSource,
    windowsPerRegime: requestedWindowsPerRegime,
    windowBars: effectiveWindowBars,
    minDominantRegimePct: regimeSource === "ohlcv_proxy" ? 50 : 65,
  };
  const validation = runRegimeValidation(validationOptions);

  const routing = routingSummaries(baseInput, validation.selectedWindows);
  const portfolios = portfolioSummaries(baseInput, validation.selectedWindows);
  const warnings = validationWarnings({
    requestedWindowsPerRegime,
    configuredWindowBars,
    effectiveWindowBars,
    selectedWindows: validation.selectedWindows,
    aggregates: validation.aggregates,
    regimeSource,
    clampedWindowBars: effectiveWindowBars !== configuredWindowBars,
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
    `Regime source: ${regimeSource === "a6_snapshots" ? "persisted A6 snapshots" : "OHLCV proxy fallback"}`,
    `Window bars: ${validation.selectedWindows[0]?.barCount ?? validationOptions.windowBars}`,
    `Requested windows per regime: ${requestedWindowsPerRegime}`,
    `Selected windows: ${validation.selectedWindows.length} (${coverage})`,
    persistedRegimes.length === 0
      ? "Note: no persisted A6 regime snapshots were available, so this run used OHLCV proxy labels for research-only validation."
      : "",
    warnings.length > 0 ? "" : "",
    warnings.length > 0 ? "### Validation Warnings" : "",
    ...warnings.map((warning) => `- ${warning}`),
    "",
    "### Multi-Window Results",
    aggregateTable(validation.aggregates),
    "",
    "### A6 Routing Results",
    summaryTable(routing),
    "",
    "### Portfolio Results",
    summaryTable(portfolios),
    "",
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
    "- Added OHLCV proxy regime fallback for TREND_UP, TREND_DOWN, HIGH_VOL, LOW_VOL, NEWS_SHOCK, and CHOP when persisted A6 snapshots are unavailable.",
    "- Proxy validation uses meaningful windows by default: 144 bars preferred and 72 bars minimum. Coverage is reported honestly when fewer than the requested windows are available.",
    "- Kept persistence schema unchanged because run metrics are stored as JSONB.",
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
    "- Regime validation prefers persisted A6 snapshots. If none exist, it builds research-only proxy labels from OHLCV volatility, range, trend, and shock features.",
    "- `regime -> []` and missing regime mappings produce no trade, allowing future capital-preservation experiments.",
    "- Portfolio research validates `sum(weights) <= 100%` and rejects implicit leverage.",
    "- Validation tooling accepts `symbol`, `exchange`, `assetType`, and `dataSource` for multi-asset expansion.",
    "",
    "## Issues Found",
    "",
    "- If persisted A6 snapshots are absent, reported regime samples are proxy-classified and should not be treated as A6 detector validation.",
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
