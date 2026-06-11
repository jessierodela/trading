import type { RegimeContext, StrategySignal } from "@/lib/quant/types";

export type { RegimeContext, StrategySignal } from "@/lib/quant/types";

export type RiskPositionSide = "LONG" | "SHORT";

export interface RiskConfig {
  enabled: boolean;
  maxRiskPerTradePct: number;
  maxDailyLossPct: number;
  maxWeeklyLossPct?: number;
  maxOpenPositions: number;
  maxSymbolExposurePct: number;
  maxPortfolioExposurePct: number;
  minRegimeReliability: number;
  blockedRegimes: string[];
  allowLong: boolean;
  allowShort: boolean;
  defaultStopLossPct: number;
  defaultTakeProfitPct: number;
  maxLeverage: number;
  staleSignalMaxAgeMs: number;
  duplicateCooldownMs: number;
  maxConsecutiveLosses?: number;
  highVolSizeMultiplier: number;
  chopSizeMultiplier: number;
  newsShockBlocksTrading: boolean;
  killSwitchEnabled: boolean;
  maxOpenPositionDrawdownPct?: number;
}

export interface Position {
  symbol: string;
  side: RiskPositionSide;
  quantity: number;
  entryPrice: number;
  markPrice: number;
  openedAt: string;
  unrealizedPnl: number;
  riskUsd?: number;
}

export interface PnlSnapshot {
  ts: string;
  realizedPnl: number;
  unrealizedPnl: number;
  equity: number;
  consecutiveLosses?: number;
}

export interface RiskInput {
  signal: StrategySignal;
  regime: RegimeContext;
  accountEquity: number;
  openPositions: Position[];
  recentPnL: PnlSnapshot[];
  config: RiskConfig;
  nowTs?: string;
}

export interface RiskDecision {
  approved: boolean;
  reason: string;
  sizeMultiplier: number;
  maxRiskUsd: number;
  positionSize: number;
  stopLoss: number | null;
  takeProfit: number | null;
  blockedBy: string[];
  warnings: string[];
}
