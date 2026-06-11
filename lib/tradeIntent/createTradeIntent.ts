import type { RiskDecision } from "@/lib/risk/types";
import type { CreateTradeIntentInput, TradeIntent } from "./types";

function assertFiniteNonNegative(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
}

function assertTimestamp(label: string, value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be a valid timestamp`);
}

function copyRiskDecision(decision: RiskDecision): RiskDecision {
  return {
    ...decision,
    blockedBy: [...decision.blockedBy],
    warnings: [...decision.warnings],
  };
}

export function createTradeIntent(input: CreateTradeIntentInput): TradeIntent {
  const { signal, riskDecision } = input;
  if (signal.direction !== "long" && signal.direction !== "short") {
    throw new Error("trade intent requires a LONG or SHORT strategy signal");
  }
  if (riskDecision.riskVersion.trim().length === 0) {
    throw new Error("riskDecision.riskVersion is required");
  }
  if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0) {
    throw new Error("entryPrice must be a finite positive number");
  }
  if (input.entryLogic.trim().length === 0) throw new Error("entryLogic is required");
  assertFiniteNonNegative("riskDecision.positionSize", riskDecision.positionSize);
  assertFiniteNonNegative("riskDecision.maxRiskUsd", riskDecision.maxRiskUsd);

  const createdAt = input.nowTs ?? signal.ts;
  assertTimestamp("signal.ts", signal.ts);
  assertTimestamp("createdAt", createdAt);
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    assertTimestamp("expiresAt", input.expiresAt);
    if (Date.parse(input.expiresAt) < Date.parse(createdAt)) {
      throw new Error("expiresAt must be at or after createdAt");
    }
  }

  const decision = copyRiskDecision(riskDecision);
  const metadata = structuredClone(input.metadata ?? {});
  metadata.riskWarnings = [...decision.warnings];
  if (!decision.approved) metadata.riskBlockedBy = [...decision.blockedBy];

  return {
    symbol: signal.symbol,
    exchange: signal.exchange,
    timeframe: signal.timeframe,
    ts: signal.ts,
    sourceSignalIds: [...(input.sourceSignalIds ?? [])],
    strategyId: signal.strategyId,
    strategyVersion: signal.strategyVersion,
    featureVersion: signal.featureVersion,
    direction: signal.direction === "long" ? "LONG" : "SHORT",
    status: decision.approved ? "risk_approved" : "risk_rejected",
    entryLogic: input.entryLogic,
    entryPrice: input.entryPrice,
    stopLoss: decision.stopLoss,
    takeProfit: decision.takeProfit,
    suggestedSize: decision.approved ? decision.positionSize : 0,
    maxRiskUsd: decision.maxRiskUsd,
    riskDecision: decision,
    metadata,
    createdAt,
    expiresAt: input.expiresAt ?? null,
  };
}
