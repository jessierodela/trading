import type { Bar } from "@/lib/quant/types";
import type {
  BacktestConfig,
  BacktestMetrics,
  EquityPoint,
  SimulatedTrade,
} from "./types";

function pct(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
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
  const profitFactor = profitFactorFor(trades);
  if (profitFactor === null) notes.push("Profit factor unavailable because there were no losing trades");

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
  for (const trade of trades) {
    if (trade.pnl < 0) {
      consecutiveLosses++;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutiveLosses);
    } else {
      consecutiveLosses = 0;
    }
  }

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
    averageWinner: avg(winners),
    averageLoser: avg(losers),
    profitFactor,
    expectancyPerTrade: avg(trades.map((t) => t.pnl)),
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

