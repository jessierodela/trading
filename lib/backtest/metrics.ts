import type { Bar } from "@/lib/quant/types";
import type {
  BacktestConfig,
  BacktestMetrics,
  EquityPoint,
  SimulatedTrade,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEFRAME_MS: Record<BacktestConfig["timeframe"], number> = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "1d": DAY_MS,
};

function pct(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function profitFactorFor(trades: Pick<SimulatedTrade, "pnl">[]): number | null {
  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = trades.filter((t) => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0);
  if (grossLoss === 0) return null;
  return grossProfit / Math.abs(grossLoss);
}

function winRateFor(trades: Pick<SimulatedTrade, "pnl">[]): number | null {
  if (trades.length === 0) return null;
  return pct(trades.filter((t) => t.pnl > 0).length, trades.length);
}

function stddev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = avg(values);
  if (mean === null) return null;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function durationMsFor(trade: SimulatedTrade, fallbackBarMs: number): number {
  if (trade.exitTs !== null) {
    const duration = Date.parse(trade.exitTs) - Date.parse(trade.entryTs);
    if (Number.isFinite(duration) && duration >= 0) return duration;
  }
  return Math.max(1, trade.holdBars) * fallbackBarMs;
}

export function calculateBacktestMetrics(
  config: BacktestConfig,
  trades: SimulatedTrade[],
  equityCurve: EquityPoint[],
  bars: Bar[],
): BacktestMetrics {
  const notes: string[] = [];
  const endingEquity = equityCurve[equityCurve.length - 1]?.equity ?? config.initialCapital;
  const totalReturnPct = pct(endingEquity - config.initialCapital, config.initialCapital);
  const maxDrawdownPct = Math.max(0, ...equityCurve.map((p) => p.drawdownPct));

  const durationMs = Date.parse(config.endTs) - Date.parse(config.startTs);
  const yearMs = 365 * 24 * 60 * 60 * 1000;
  let cagrPct: number | null = null;
  if (durationMs >= yearMs && endingEquity > 0) {
    cagrPct = (Math.pow(endingEquity / config.initialCapital, yearMs / durationMs) - 1) * 100;
  } else {
    notes.push("CAGR unavailable for windows shorter than 365 days");
  }

  const winners = trades.filter((t) => t.pnl > 0).map((t) => t.pnl);
  const losers = trades.filter((t) => t.pnl < 0).map((t) => t.pnl);
  const lossesAbs = losers.map((pnl) => Math.abs(pnl));
  const profitFactor = profitFactorFor(trades);
  if (profitFactor === null) notes.push("Profit factor unavailable because there were no losing trades");
  const avgWin = avg(winners);
  const avgLoss = avg(lossesAbs);
  const winRate = trades.length === 0 ? null : winners.length / trades.length;
  const lossRate = trades.length === 0 ? null : losers.length / trades.length;
  const expectancy = winRate === null || lossRate === null
    ? null
    : winRate * (avgWin ?? 0) - lossRate * (avgLoss ?? 0);

  const returns = equityCurve.slice(1)
    .map((point, idx) => {
      const prev = equityCurve[idx].equity;
      return prev === 0 ? 0 : (point.equity - prev) / prev;
    })
    .filter((x) => Number.isFinite(x));

  let sharpeApprox: number | null = null;
  let sortinoApprox: number | null = null;
  const meanReturn = avg(returns);
  const returnStd = stddev(returns);
  if (returns.length >= 2 && meanReturn !== null && returnStd !== null && returnStd > 0) {
    sharpeApprox = meanReturn / returnStd * Math.sqrt(365 * 24);
  } else {
    notes.push("Sharpe approximation unavailable with too few non-zero equity returns");
  }
  const downside = returns.filter((r) => r < 0);
  const downsideStd = stddev(downside);
  if (returns.length >= 2 && meanReturn !== null && downsideStd !== null && downsideStd > 0) {
    sortinoApprox = meanReturn / downsideStd * Math.sqrt(365 * 24);
  } else {
    notes.push("Sortino approximation unavailable with too few downside returns");
  }

  let maxConsecutiveLosses = 0;
  let consecutiveLosses = 0;
  let maxWinningStreak = 0;
  let maxLosingStreak = 0;
  let consecutiveWins = 0;
  for (const trade of trades) {
    if (trade.pnl < 0) {
      consecutiveLosses++;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutiveLosses);
      maxLosingStreak = Math.max(maxLosingStreak, consecutiveLosses);
      consecutiveWins = 0;
    } else if (trade.pnl > 0) {
      consecutiveWins++;
      maxWinningStreak = Math.max(maxWinningStreak, consecutiveWins);
      consecutiveLosses = 0;
    } else {
      consecutiveLosses = 0;
      consecutiveWins = 0;
    }
  }

  const barMs = TIMEFRAME_MS[config.timeframe];
  const tradeDurationBars = trades.map((t) => t.holdBars);
  const tradeDurationMs = trades.map((t) => durationMsFor(t, barMs));
  const totalBarsHeld = tradeDurationBars.reduce((sum, value) => sum + value, 0);
  const netProfit = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const totalTradeDurationMs = tradeDurationMs.reduce((sum, value) => sum + value, 0);
  const backtestDurationMs = Math.max(0, Date.parse(config.endTs) - Date.parse(config.startTs));
  const exposurePct = backtestDurationMs === 0
    ? null
    : Math.min(100, totalTradeDurationMs / backtestDurationMs * 100);
  const tradeFrequency = backtestDurationMs === 0
    ? null
    : trades.length / (backtestDurationMs / DAY_MS);

  const regimePerformance: BacktestMetrics["regimePerformance"] = {};
  for (const trade of trades) {
    const key = trade.regimeAtEntry;
    const bucket = regimePerformance[key] ?? { trades: 0, totalPnl: 0, winRatePct: null, profitFactor: null };
    bucket.trades++;
    bucket.totalPnl += trade.pnl;
    regimePerformance[key] = bucket;
  }
  for (const key of Object.keys(regimePerformance)) {
    const bucketTrades = trades.filter((t) => t.regimeAtEntry === key);
    regimePerformance[key].winRatePct = winRateFor(bucketTrades);
    regimePerformance[key].profitFactor = profitFactorFor(bucketTrades);
  }

  const timeOfDayPerformance: BacktestMetrics["timeOfDayPerformance"] = {};
  for (let hour = 0; hour < 24; hour++) {
    const key = String(hour).padStart(2, "0");
    const bucketTrades = trades.filter((t) => t.entryHourUtc === hour);
    timeOfDayPerformance[key] = {
      trades: bucketTrades.length,
      totalPnl: bucketTrades.reduce((sum, t) => sum + t.pnl, 0),
      winRatePct: winRateFor(bucketTrades),
    };
  }

  return {
    initialCapital: config.initialCapital,
    endingEquity,
    totalReturnPct,
    cagrPct,
    maxDrawdownPct,
    numberOfTrades: trades.length,
    winRatePct: winRateFor(trades),
    averageWinner: avgWin,
    averageLoser: avg(losers),
    profitFactor,
    expectancyPerTrade: expectancy,
    expectancy,
    avgWin,
    avgLoss,
    maxWinningStreak,
    maxLosingStreak,
    exposurePct,
    avgTradeDurationBars: avg(tradeDurationBars),
    avgTradeDurationMs: avg(tradeDurationMs),
    medianTradeDurationBars: median(tradeDurationBars),
    medianTradeDurationMs: median(tradeDurationMs),
    sharpeRatio: sharpeApprox,
    sortinoRatio: sortinoApprox,
    profitPerBar: totalBarsHeld === 0 ? null : netProfit / totalBarsHeld,
    returnToDrawdown: maxDrawdownPct === 0 ? null : totalReturnPct / maxDrawdownPct,
    tradeFrequency,
    sharpeApprox,
    sortinoApprox,
    exposureTimePct: pct(equityCurve.filter((p) => p.openPositionMarketValue > 0).length, bars.length),
    averageHoldHours: avg(trades.map((t) => t.holdHours)),
    bestTradePnl: trades.length > 0 ? Math.max(...trades.map((t) => t.pnl)) : null,
    worstTradePnl: trades.length > 0 ? Math.min(...trades.map((t) => t.pnl)) : null,
    maxConsecutiveLosses,
    regimePerformance,
    timeOfDayPerformance,
    notes,
  };
}

