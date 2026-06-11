import type {
  PnlSnapshot,
  Position,
  RegimeContext,
  RiskConfig,
  RiskInput,
  StrategySignal,
} from "./types";

export interface BacktestRiskInputContext {
  signal: StrategySignal;
  regime?: RegimeContext | null;
  accountEquity: number;
  openPositions?: Position[];
  recentPnL?: PnlSnapshot[];
  config: RiskConfig;
}

export function buildRiskInputFromBacktestContext(context: BacktestRiskInputContext): RiskInput {
  return {
    signal: context.signal,
    regime: context.regime ?? null,
    accountEquity: context.accountEquity,
    openPositions: context.openPositions ?? [],
    recentPnL: context.recentPnL ?? [],
    config: context.config,
  };
}
