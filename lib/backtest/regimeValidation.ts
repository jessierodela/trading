import type { Bar, FeatureSnapshot, RegimeContext, RegimeLabel } from "@/lib/quant/types";
import { STRATEGY_REGISTRY } from "@/lib/strategies/strategyRegistry";
import { runBacktest } from "./backtestEngine";
import type {
  BacktestConfig,
  BacktestInput,
  BacktestInstrumentContext,
  BacktestMetrics,
  BacktestResult,
} from "./types";

export const REQUIRED_REGIMES: RegimeLabel[] = [
  "TREND_UP",
  "TREND_DOWN",
  "HIGH_VOL",
  "LOW_VOL",
  "NEWS_SHOCK",
  "CHOP",
];

export interface RegimeCandidateWindow {
  instrument: BacktestInstrumentContext;
  regime: RegimeLabel;
  regimeSource: RegimeValidationSource;
  startTs: string;
  endTs: string;
  score: number;
  barCount: number;
  dominantRegimePct: number;
  avgReliability: number;
  returnPct: number;
  avgAtrPct: number | null;
}

export type RegimeValidationSource = "a6_snapshots" | "ohlcv_proxy";

export interface RegimeValidationOptions {
  instrument: BacktestInstrumentContext;
  baseConfig: Omit<BacktestConfig, "symbol" | "exchange" | "strategyId" | "startTs" | "endTs">;
  bars: Bar[];
  features: FeatureSnapshot[];
  dailyFeatures?: FeatureSnapshot[];
  regimes: RegimeContext[];
  regimeSource?: RegimeValidationSource;
  strategyIds?: string[];
  windowBars?: number;
  windowsPerRegime?: number;
  minDominantRegimePct?: number;
}

export interface RegimeWindowBacktest {
  window: RegimeCandidateWindow;
  strategyId: string;
  result: BacktestResult;
}

export interface AggregatedRegimeMetrics {
  regime: RegimeLabel;
  strategyId: string;
  samples: number;
  averageReturn: number | null;
  medianReturn: number | null;
  averageDrawdown: number | null;
  medianDrawdown: number | null;
  maxDrawdown: number | null;
  averageExpectancy: number | null;
  averageProfitFactor: number | null;
  averageWinRate: number | null;
  averageExposure: number | null;
  averageTradeCount: number | null;
  returnToDrawdown: number | null;
}

export interface StabilityRanking {
  regime: RegimeLabel;
  strategyId: string;
  samples: number;
  score: number | null;
  returnConsistency: number | null;
  drawdownConsistency: number | null;
  profitFactorStability: number | null;
  expectancyStability: number | null;
}

export interface RegimeValidationResult {
  instrument: BacktestInstrumentContext;
  regimeSource: RegimeValidationSource;
  selectedWindows: RegimeCandidateWindow[];
  backtests: RegimeWindowBacktest[];
  aggregates: AggregatedRegimeMetrics[];
  stabilityRankings: StabilityRanking[];
  notes: string[];
}

const TIMEFRAME_MS: Record<BacktestConfig["timeframe"], number> = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

const DEFAULT_PROXY_LOOKBACK_BARS = 144;

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stddev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = avg(values);
  if (mean === null) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function quantile(values: number[], percentile: number): number | null {
  const finite = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const index = Math.min(finite.length - 1, Math.max(0, Math.floor((finite.length - 1) * percentile)));
  return finite[index];
}

function rollingSlice<T>(rows: T[], index: number, lookback: number): T[] {
  return rows.slice(Math.max(0, index - lookback + 1), index + 1);
}

function rollingSum(values: number[], index: number, lookback: number): number {
  return rollingSlice(values, index, lookback).reduce((sum, value) => sum + value, 0);
}

function rollingMax(values: number[], index: number, lookback: number): number {
  const rows = rollingSlice(values, index, lookback);
  return rows.length === 0 ? 0 : Math.max(...rows);
}

function reliabilityForProxy(score: number): number {
  return Math.max(0.35, Math.min(0.95, score));
}

function thresholdRatio(value: number, threshold: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(threshold) || threshold <= 0) return 0;
  return value / threshold;
}

export function buildOhlcvProxyRegimes(
  bars: Bar[],
  features: FeatureSnapshot[] = [],
  lookbackBars = DEFAULT_PROXY_LOOKBACK_BARS,
): RegimeContext[] {
  if (bars.length === 0) return [];

  const featureByTs = new Map(features.map((feature) => [feature.ts, feature]));
  const oneBarReturns = bars.map((bar, index) => {
    if (index === 0) return 0;
    const previousClose = bars[index - 1].close;
    return previousClose === 0 ? 0 : (bar.close - previousClose) / previousClose * 100;
  });
  const rangePct = bars.map((bar) => bar.open === 0 ? 0 : (bar.high - bar.low) / bar.open * 100);
  const rollingReturns = bars.map((bar, index) => {
    const anchor = bars[Math.max(0, index - lookbackBars)];
    return anchor.close === 0 ? 0 : (bar.close - anchor.close) / anchor.close * 100;
  });
  const rollingVol = oneBarReturns.map((_, index) => stddev(rollingSlice(oneBarReturns, index, lookbackBars)) ?? 0);
  const atrPct = bars.map((bar, index) => featureByTs.get(bar.ts)?.atrPct ?? rangePct[index]);
  const volatilityMetric = rollingVol.map((value, index) => Math.max(value, atrPct[index]));
  const relativeVolume = bars.map((bar) => featureByTs.get(bar.ts)?.relativeVolume20 ?? 1);
  const candleRangeAtr = bars.map((bar, index) => featureByTs.get(bar.ts)?.candleRangeAtr ?? Math.max(0, rangePct[index] / Math.max(atrPct[index], 0.0001)));
  const ema20SlopePct = bars.map((bar) => {
    const slope = featureByTs.get(bar.ts)?.ema20Slope;
    return typeof slope === "number" && bar.close !== 0 ? Math.abs(slope / bar.close * 100) : 0;
  });
  const rsi14 = bars.map((bar) => featureByTs.get(bar.ts)?.rsi14 ?? null);

  const absOneBarReturns = oneBarReturns.map(Math.abs);
  const absRollingReturns = rollingReturns.map(Math.abs);
  const pathMovement = absOneBarReturns.map((_, index) => rollingSum(absOneBarReturns, index, lookbackBars));
  const efficiency = absRollingReturns.map((value, index) => pathMovement[index] === 0 ? 0 : value / pathMovement[index]);
  const signChanges = oneBarReturns.map((value, index) => {
    if (index === 0) return 0;
    const previous = oneBarReturns[index - 1];
    if (Math.abs(value) < 0.01 || Math.abs(previous) < 0.01) return 0;
    return Math.sign(value) !== Math.sign(previous) ? 1 : 0;
  });
  const signChangeRate = signChanges.map((_, index) =>
    rollingSum(signChanges, index, lookbackBars) / Math.max(1, Math.min(index, lookbackBars - 1)),
  );

  const shockReturnThreshold = quantile(absOneBarReturns, 0.985) ?? 0;
  const shockRangeThreshold = quantile(rangePct, 0.985) ?? 0;
  const shockVolumeThreshold = Math.max(quantile(relativeVolume, 0.985) ?? 0, 2.5);
  const shockCandleAtrThreshold = Math.max(quantile(candleRangeAtr, 0.985) ?? 0, 2.5);
  const extremeShockReturnThreshold = quantile(absOneBarReturns, 0.995) ?? shockReturnThreshold;
  const extremeShockRangeThreshold = quantile(rangePct, 0.995) ?? shockRangeThreshold;
  const shockPulse = bars.map((_, index) => index > 0 && (
    absOneBarReturns[index] >= shockReturnThreshold ||
    rangePct[index] >= shockRangeThreshold ||
    relativeVolume[index] >= shockVolumeThreshold ||
    candleRangeAtr[index] >= shockCandleAtrThreshold
  ) ? 1 : 0);
  const extremeShockPulse = bars.map((_, index) => index > 0 && (
    absOneBarReturns[index] >= extremeShockReturnThreshold ||
    rangePct[index] >= extremeShockRangeThreshold
  ) ? 1 : 0);
  const shockClusterLookback = Math.max(24, Math.floor(lookbackBars * 0.75));
  const shockCounts = shockPulse.map((_, index) => rollingSum(shockPulse, index, shockClusterLookback));
  const extremeShockCounts = extremeShockPulse.map((_, index) => rollingSum(extremeShockPulse, index, shockClusterLookback));

  const highVolThreshold = quantile(volatilityMetric, 0.62) ?? 0;
  const extremeVolThreshold = quantile(volatilityMetric, 0.78) ?? highVolThreshold;
  const ultraVolThreshold = quantile(volatilityMetric, 0.86) ?? extremeVolThreshold;
  const lowVolThreshold = quantile(volatilityMetric, 0.28) ?? 0;
  const trendThreshold = quantile(absRollingReturns, 0.58) ?? 0;
  const strongTrendThreshold = quantile(absRollingReturns, 0.78) ?? trendThreshold;
  const chopTrendThreshold = quantile(absRollingReturns, 0.45) ?? 0;
  const chopEfficiencyThreshold = quantile(efficiency, 0.38) ?? 0;
  const flatSlopeThreshold = quantile(ema20SlopePct, 0.45) ?? 0;

  return bars.map((bar, index) => {
    const volatility = volatilityMetric[index];
    const trend = rollingReturns[index];
    const absTrend = Math.abs(trend);
    const absReturn = absOneBarReturns[index];
    const shockCount = shockCounts[index];
    const shockIntensity = Math.max(
      thresholdRatio(rollingMax(absOneBarReturns, index, shockClusterLookback), shockReturnThreshold),
      thresholdRatio(rollingMax(rangePct, index, shockClusterLookback), shockRangeThreshold),
      thresholdRatio(rollingMax(relativeVolume, index, shockClusterLookback), shockVolumeThreshold),
      thresholdRatio(rollingMax(candleRangeAtr, index, shockClusterLookback), shockCandleAtrThreshold),
    );
    const isShockCluster = (
      shockCount >= Math.max(5, Math.floor(shockClusterLookback * 0.04)) ||
      extremeShockCounts[index] >= 1
    ) && volatility >= highVolThreshold * 0.8;
    const rsi = rsi14[index];
    const neutralMomentum = rsi === null || (rsi >= 40 && rsi <= 60);
    const flatTrend = ema20SlopePct[index] <= flatSlopeThreshold || absTrend <= chopTrendThreshold;
    const isChop = neutralMomentum &&
      flatTrend &&
      signChangeRate[index] >= 0.42 &&
      efficiency[index] <= Math.max(chopEfficiencyThreshold, 0.22) &&
      volatility > lowVolThreshold * 0.9 &&
      volatility < extremeVolThreshold * 1.1;

    if (isShockCluster && absTrend <= trendThreshold) {
      return { ts: bar.ts, regime: "NEWS_SHOCK", reliability: reliabilityForProxy(0.58 + shockIntensity * 0.1 + shockCount / Math.max(shockClusterLookback, 1)) };
    }
    if (volatility >= ultraVolThreshold) {
      return { ts: bar.ts, regime: "HIGH_VOL", reliability: reliabilityForProxy(0.58 + volatility / Math.max(highVolThreshold * 6, 1)) };
    }
    if (trend <= -trendThreshold && absTrend > volatility * 0.35) {
      return { ts: bar.ts, regime: "TREND_DOWN", reliability: reliabilityForProxy(0.55 + absTrend / Math.max(trendThreshold * 6, 1)) };
    }
    if (volatility >= extremeVolThreshold) {
      return { ts: bar.ts, regime: "HIGH_VOL", reliability: reliabilityForProxy(0.55 + volatility / Math.max(highVolThreshold * 6, 1)) };
    }
    if (trend >= trendThreshold && absTrend > volatility * 0.4) {
      return { ts: bar.ts, regime: "TREND_UP", reliability: reliabilityForProxy(0.55 + absTrend / Math.max(trendThreshold * 6, 1)) };
    }
    if (isChop) {
      return { ts: bar.ts, regime: "CHOP", reliability: reliabilityForProxy(0.55 + (1 - efficiency[index]) * 0.2 + signChangeRate[index] * 0.1) };
    }
    if (volatility >= highVolThreshold && shockCount > 0) {
      return { ts: bar.ts, regime: "HIGH_VOL", reliability: reliabilityForProxy(0.55 + volatility / Math.max(highVolThreshold * 6, 1)) };
    }
    if (volatility <= lowVolThreshold && absTrend <= trendThreshold) {
      return { ts: bar.ts, regime: "LOW_VOL", reliability: reliabilityForProxy(0.55 + (lowVolThreshold - volatility) / Math.max(lowVolThreshold * 4, 1)) };
    }
    if (absTrend <= chopTrendThreshold || absTrend <= volatility) {
      return { ts: bar.ts, regime: "CHOP", reliability: reliabilityForProxy(0.58 + (1 - efficiency[index]) * 0.15) };
    }
    return {
      ts: bar.ts,
      regime: trend >= 0 ? "TREND_UP" : "TREND_DOWN",
      reliability: reliabilityForProxy(0.5),
    };
  });
}

function latestRegimeAtOrBefore(regimes: RegimeContext[], ts: string): RegimeContext | null {
  let latest: RegimeContext | null = null;
  for (const regime of regimes) {
    if (regime.ts <= ts) latest = regime;
    if (regime.ts > ts) break;
  }
  return latest;
}

function overlaps(a: RegimeCandidateWindow, b: RegimeCandidateWindow): boolean {
  return a.startTs < b.endTs && b.startTs < a.endTs;
}

function isContiguous(bars: Bar[], expectedMs: number): boolean {
  for (let index = 1; index < bars.length; index++) {
    if (Date.parse(bars[index].ts) - Date.parse(bars[index - 1].ts) !== expectedMs) return false;
  }
  return true;
}

export function scoreCandidateWindows(options: RegimeValidationOptions): RegimeCandidateWindow[] {
  const windowBars = options.windowBars ?? 24 * 14;
  const minDominantRegimePct = options.minDominantRegimePct ?? 65;
  const regimes = [...options.regimes].sort((a, b) => a.ts.localeCompare(b.ts));
  const featuresByTs = new Map(options.features.map((feature) => [feature.ts, feature]));
  const candidates: RegimeCandidateWindow[] = [];

  for (let start = 0; start + windowBars <= options.bars.length; start += Math.max(1, Math.floor(windowBars / 2))) {
    const windowBarsSlice = options.bars.slice(start, start + windowBars);
    if (!isContiguous(windowBarsSlice, TIMEFRAME_MS[options.baseConfig.timeframe])) continue;
    const counts = new Map<RegimeLabel, number>();
    const reliabilities: number[] = [];

    for (const bar of windowBarsSlice) {
      const regime = latestRegimeAtOrBefore(regimes, bar.ts);
      if (!regime) continue;
      counts.set(regime.regime, (counts.get(regime.regime) ?? 0) + 1);
      reliabilities.push(regime.reliability);
    }

    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const dominant = ranked[0];
    if (!dominant) continue;

    const regime = dominant[0];
    const dominantRegimePct = dominant[1] / windowBarsSlice.length * 100;
    if (dominantRegimePct < minDominantRegimePct) continue;

    const startBar = windowBarsSlice[0];
    const endBar = windowBarsSlice[windowBarsSlice.length - 1];
    const featureAtrPct = windowBarsSlice
      .map((bar) => featuresByTs.get(bar.ts)?.atrPct)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const returnPct = startBar.open === 0 ? 0 : (endBar.close - startBar.open) / startBar.open * 100;
    const avgReliability = avg(reliabilities) ?? 0;
    const score = dominantRegimePct * 0.7 + avgReliability * 30;
    const endTs = new Date(Date.parse(endBar.ts) + TIMEFRAME_MS[options.baseConfig.timeframe]).toISOString();

    candidates.push({
      instrument: options.instrument,
      regime,
      regimeSource: options.regimeSource ?? "a6_snapshots",
      startTs: startBar.ts,
      endTs,
      score,
      barCount: windowBarsSlice.length,
      dominantRegimePct,
      avgReliability,
      returnPct,
      avgAtrPct: avg(featureAtrPct),
    });
  }

  return candidates.sort((a, b) => b.score - a.score);
}

export function selectNonOverlappingWindows(
  candidates: RegimeCandidateWindow[],
  windowsPerRegime: number,
): RegimeCandidateWindow[] {
  const selected: RegimeCandidateWindow[] = [];
  for (const regime of REQUIRED_REGIMES) {
    const regimeSelected: RegimeCandidateWindow[] = [];
    for (const candidate of candidates.filter((window) => window.regime === regime)) {
      if (regimeSelected.length >= windowsPerRegime) break;
      if (regimeSelected.some((window) => overlaps(window, candidate))) continue;
      regimeSelected.push(candidate);
    }
    selected.push(...regimeSelected);
  }
  return selected.sort((a, b) => a.startTs.localeCompare(b.startTs));
}

function sliceInput(options: RegimeValidationOptions, window: RegimeCandidateWindow, strategyId: string): BacktestInput {
  return {
    config: {
      ...options.baseConfig,
      symbol: options.instrument.symbol,
      exchange: options.instrument.exchange,
      assetType: options.instrument.assetType,
      dataSource: options.instrument.dataSource,
      strategyId,
      startTs: window.startTs,
      endTs: window.endTs,
    },
    bars: options.bars.filter((bar) => bar.ts >= window.startTs && bar.ts < window.endTs),
    features: options.features.filter((feature) => feature.ts >= window.startTs && feature.ts < window.endTs),
    dailyFeatures: options.dailyFeatures?.filter((feature) => feature.ts < window.endTs),
    regimes: options.regimes.filter((regime) => regime.ts <= window.endTs),
  };
}

function metricSeries(
  backtests: RegimeWindowBacktest[],
  regime: RegimeLabel,
  strategyId: string,
  pick: (metrics: BacktestMetrics) => number | null,
): number[] {
  return backtests
    .filter((row) => row.window.regime === regime && row.strategyId === strategyId)
    .map((row) => pick(row.result.metrics))
    .filter((value): value is number => value !== null && Number.isFinite(value));
}

export function aggregateRegimeMetrics(
  backtests: RegimeWindowBacktest[],
  strategyIds: string[],
): AggregatedRegimeMetrics[] {
  const rows: AggregatedRegimeMetrics[] = [];
  for (const regime of REQUIRED_REGIMES) {
    for (const strategyId of strategyIds) {
      const returns = metricSeries(backtests, regime, strategyId, (m) => m.totalReturnPct);
      const drawdowns = metricSeries(backtests, regime, strategyId, (m) => m.maxDrawdownPct);
      const expectancies = metricSeries(backtests, regime, strategyId, (m) => m.expectancy);
      const profitFactors = metricSeries(backtests, regime, strategyId, (m) => m.profitFactor);
      const winRates = metricSeries(backtests, regime, strategyId, (m) => m.winRatePct);
      const exposures = metricSeries(backtests, regime, strategyId, (m) => m.exposurePct);
      const tradeCounts = metricSeries(backtests, regime, strategyId, (m) => m.numberOfTrades);
      rows.push({
        regime,
        strategyId,
        samples: returns.length,
        averageReturn: avg(returns),
        medianReturn: median(returns),
        averageDrawdown: avg(drawdowns),
        medianDrawdown: median(drawdowns),
        maxDrawdown: drawdowns.length === 0 ? null : Math.max(...drawdowns),
        averageExpectancy: avg(expectancies),
        averageProfitFactor: avg(profitFactors),
        averageWinRate: avg(winRates),
        averageExposure: avg(exposures),
        averageTradeCount: avg(tradeCounts),
        returnToDrawdown: (avg(drawdowns) ?? 0) === 0 ? null : (avg(returns) ?? 0) / (avg(drawdowns) as number),
      });
    }
  }
  return rows;
}

export function rankStability(backtests: RegimeWindowBacktest[], strategyIds: string[]): StabilityRanking[] {
  const rows: StabilityRanking[] = [];
  for (const regime of REQUIRED_REGIMES) {
    for (const strategyId of strategyIds) {
      const returns = metricSeries(backtests, regime, strategyId, (m) => m.totalReturnPct);
      const drawdowns = metricSeries(backtests, regime, strategyId, (m) => m.maxDrawdownPct);
      const profitFactors = metricSeries(backtests, regime, strategyId, (m) => m.profitFactor);
      const expectancies = metricSeries(backtests, regime, strategyId, (m) => m.expectancy);
      const returnConsistency = stddev(returns);
      const drawdownConsistency = stddev(drawdowns);
      const profitFactorStability = stddev(profitFactors);
      const expectancyStability = stddev(expectancies);
      const penalties = [returnConsistency, drawdownConsistency, profitFactorStability, expectancyStability]
        .filter((value): value is number => value !== null);
      const averageReturn = avg(returns);
      rows.push({
        regime,
        strategyId,
        samples: returns.length,
        score: averageReturn === null || penalties.length === 0
          ? null
          : averageReturn - penalties.reduce((sum, value) => sum + value, 0) / penalties.length,
        returnConsistency,
        drawdownConsistency,
        profitFactorStability,
        expectancyStability,
      });
    }
  }
  return rows.sort((a, b) => {
    if (a.regime !== b.regime) return a.regime.localeCompare(b.regime);
    return (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY);
  });
}

export function runRegimeValidation(options: RegimeValidationOptions): RegimeValidationResult {
  const strategyIds = options.strategyIds ?? STRATEGY_REGISTRY.map((strategy) => strategy.id);
  const candidates = scoreCandidateWindows(options);
  const selectedWindows = selectNonOverlappingWindows(candidates, options.windowsPerRegime ?? 10);
  const backtests: RegimeWindowBacktest[] = [];

  for (const window of selectedWindows) {
    for (const strategyId of strategyIds) {
      backtests.push({
        window,
        strategyId,
        result: runBacktest(sliceInput(options, window, strategyId)),
      });
    }
  }

  return {
    instrument: options.instrument,
    regimeSource: options.regimeSource ?? "a6_snapshots",
    selectedWindows,
    backtests,
    aggregates: aggregateRegimeMetrics(backtests, strategyIds),
    stabilityRankings: rankStability(backtests, strategyIds),
    notes: [
      options.regimeSource === "ohlcv_proxy"
        ? "Window scoring uses OHLCV proxy regime labels because persisted A6 snapshots were unavailable."
        : "Window scoring favors dominant A6 regime coverage and regime reliability.",
      "Selected windows are non-overlapping within each regime.",
    ],
  };
}
