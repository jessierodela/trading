import type { StrategySignal } from "@/lib/quant/types";
import type { RiskDecision } from "@/lib/risk/types";

export type TradeIntentStatus =
  | "created"
  | "risk_rejected"
  | "risk_approved"
  | "expired"
  | "cancelled";

export type TradeIntentDirection = "LONG" | "SHORT";

export interface TradeIntent {
  id?: string;
  symbol: string;
  exchange: string;
  timeframe: string;
  ts: string;
  sourceSignalIds: string[];
  strategyId: string;
  strategyVersion: string;
  featureVersion: string;
  direction: TradeIntentDirection;
  status: TradeIntentStatus;
  entryLogic: string;
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  suggestedSize: number;
  maxRiskUsd: number;
  riskDecision: RiskDecision;
  metadata: Record<string, unknown>;
  createdAt?: string;
  expiresAt?: string | null;
}

export interface CreateTradeIntentInput {
  signal: StrategySignal;
  riskDecision: RiskDecision;
  entryPrice: number;
  entryLogic: string;
  sourceSignalIds?: string[];
  metadata?: Record<string, unknown>;
  nowTs?: string;
  expiresAt?: string | null;
}

export interface TradeIntentListFilter {
  symbol?: string;
  exchange?: string;
  timeframe?: string;
  strategyId?: string;
  status?: TradeIntentStatus | TradeIntentStatus[];
  direction?: TradeIntentDirection;
  fromTs?: string;
  toTs?: string;
}
