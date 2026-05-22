import type { RegimeLabel } from "@/lib/quant/types";
import { STRATEGY_REGISTRY } from "@/lib/strategies/strategyRegistry";
import { runBacktest } from "./backtestEngine";
import { calculateBacktestMetrics } from "./metrics";
import type {
  BacktestInput,
  BacktestMetrics,
  BacktestResult,
  EquityPoint,
  SimulatedTrade,
} from "./types";

export type PortfolioMode = "equal_weight" | "custom_weight" | "regime_weight";

export type StrategyWeights = Record<string, number>;
export type RegimeStrategyWeights = Partial<Record<RegimeLabel, StrategyWeights>>;

export interface PortfolioBacktestConfig {
  mode: PortfolioMode;
  strategyIds?: string[];
  weights?: StrategyWeights;
  regimeWeights?: RegimeStrategyWeights;
}

export interface StrategyContribution {
  strategyId: string;
  weight: number | null;
  trades: number;
  totalPnl: number;
  returnContributionPct: number;
  attributionPct: number | null;
}

export interface PortfolioBacktestResult {
  mode: PortfolioMode;
  strategyResults: BacktestResult[];
  trades: SimulatedTrade[];
  equityCurve: EquityPoint[];
  metrics: BacktestMetrics;
  strategyContribution: StrategyContribution[];
  strategyAttribution: Record<string, StrategyContribution>;
  notes: string[];
}

function sumWeights(weights: StrategyWeights): number {
  return Object.values(weights).reduce((sum, weight) => sum + weight, 0);
}

function assertValidWeights(weights: StrategyWeights, label: string): void {
  for (const [strategyId, weight] of Object.entries(weights)) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`${label}.${strategyId} weight must be non-negative`);
    }
  }
  const total = sumWeights(weights);
  if (total > 1 + 1e-12) throw new Error(`${label} weights must sum to <= 1`);
}

function strategyIdsFor(config: PortfolioBacktestConfig): string[] {
  return config.strategyIds ?? STRATEGY_REGISTRY.map((strategy) => strategy.id);
}

export function equalWeightAllocation(strategyIds: string[]): StrategyWeights {
  if (strategyIds.length === 0) return {};
  const weight = 1 / strategyIds.length;
  return Object.fromEntries(strategyIds.map((strategyId) => [strategyId, weight]));
}

function weightsFor(config: PortfolioBacktestConfig, strategyIds: string[]): StrategyWeights {
  if (config.mode === "equal_weight") return equalWeightAllocation(strategyIds);
  if (config.mode === "custom_weight") return config.weights ?? {};
  return {};
}

function validatePortfolioConfig(config: PortfolioBacktestConfig, strategyIds: string[]): void {
  if (config.mode === "equal_weight") {
    assertValidWeights(equalWeightAllocation(strategyIds), "equalWeight");
    return;
  }
  if (config.mode === "custom_weight") {
    assertValidWeights(config.weights ?? {}, "weights");
    return;
  }

  const regimeWeights = config.regimeWeights ?? {};
  for (const [regime, weights] of Object.entries(regimeWeights)) {
    assertValidWeights(weights, `regimeWeights.${regime}`);
  }
}

function weightForTrade(config: PortfolioBacktestConfig, staticWeights: StrategyWeights, trade: SimulatedTrade): number {
  if (config.mode === "regime_weight") {
    if (trade.regimeAtEntry === "UNKNOWN") return 0;
    return config.regimeWeights?.[trade.regimeAtEntry]?.[trade.strategyId] ?? 0;
  }
  return staticWeights[trade.strategyId] ?? 0;
}

function scaleTrade(trade: SimulatedTrade, weight: number): SimulatedTrade {
  return {
    ...trade,
    quantity: trade.quantity * weight,
    grossPnl: trade.grossPnl * weight,
    fees: trade.fees * weight,
    slippageCost: trade.slippageCost * weight,
    pnl: trade.pnl * weight,
    pnlPct: trade.pnlPct * weight,
    reasonEntered: `${trade.reasonEntered}; portfolio_weight=${weight}`,
  };
}

function buildPortfolioEquityCurve(input: BacktestInput, trades: SimulatedTrade[]): EquityPoint[] {
  let equity = input.config.initialCapital;
  let peak = equity;
  return input.bars.map((bar) => {
    for (const trade of trades) {
      const realizationTs = trade.exitTs ?? trade.entryTs;
      if (realizationTs === bar.ts) equity += trade.pnl;
    }

    const openPositionMarketValue = trades
      .filter((trade) => trade.entryTs <= bar.ts && (trade.exitTs === null || trade.exitTs >= bar.ts))
      .reduce((sum, trade) => sum + Math.abs(trade.quantity * bar.close), 0);
    peak = Math.max(peak, equity);

    return {
      ts: bar.ts,
      equity,
      drawdownPct: peak === 0 ? 0 : (peak - equity) / peak * 100,
      openPositionMarketValue,
    };
  });
}

function contributionFor(
  strategyId: string,
  initialCapital: number,
  trades: SimulatedTrade[],
  configuredWeight: number | null,
  totalPnl: number,
): StrategyContribution {
  const strategyTrades = trades.filter((trade) => trade.strategyId === strategyId);
  const strategyPnl = strategyTrades.reduce((sum, trade) => sum + trade.pnl, 0);
  return {
    strategyId,
    weight: configuredWeight,
    trades: strategyTrades.length,
    totalPnl: strategyPnl,
    returnContributionPct: initialCapital === 0 ? 0 : strategyPnl / initialCapital * 100,
    attributionPct: totalPnl === 0 ? null : strategyPnl / totalPnl * 100,
  };
}

export function runPortfolioBacktest(input: BacktestInput, config: PortfolioBacktestConfig): PortfolioBacktestResult {
  const strategyIds = strategyIdsFor(config);
  const staticWeights = weightsFor(config, strategyIds);
  validatePortfolioConfig(config, strategyIds);

  const strategyResults = strategyIds.map((strategyId) => runBacktest({
    ...input,
    config: { ...input.config, strategyId },
    strategyRouter: undefined,
  }));

  const weightedTrades = strategyResults
    .flatMap((result) => result.trades)
    .map((trade) => ({ trade, weight: weightForTrade(config, staticWeights, trade) }))
    .filter(({ weight }) => weight > 0)
    .map(({ trade, weight }) => scaleTrade(trade, weight))
    .sort((a, b) => a.entryTs.localeCompare(b.entryTs) || a.strategyId.localeCompare(b.strategyId));

  const equityCurve = buildPortfolioEquityCurve(input, weightedTrades);
  const metrics = calculateBacktestMetrics(
    { ...input.config, strategyId: `portfolio_${config.mode}` },
    weightedTrades,
    equityCurve,
    input.bars,
  );
  const totalPnl = weightedTrades.reduce((sum, trade) => sum + trade.pnl, 0);
  const contribution = strategyIds.map((strategyId) => contributionFor(
    strategyId,
    input.config.initialCapital,
    weightedTrades,
    config.mode === "regime_weight" ? null : staticWeights[strategyId] ?? 0,
    totalPnl,
  ));

  return {
    mode: config.mode,
    strategyResults,
    trades: weightedTrades,
    equityCurve,
    metrics,
    strategyContribution: contribution,
    strategyAttribution: Object.fromEntries(contribution.map((row) => [row.strategyId, row])),
    notes: [
      "Portfolio research uses scaled simulated trade PnL only; it does not place paper or live orders.",
      "Regime-weighted portfolio equity realizes trade PnL at exits and does not model intra-trade capital contention.",
    ],
  };
}
