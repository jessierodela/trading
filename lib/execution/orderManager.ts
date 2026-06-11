import type { TradeIntent } from "@/lib/tradeIntent";
import type { CreatePaperOrderConfig, PaperOrder } from "./types";

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function rejectionReason(intent: TradeIntent, config: CreatePaperOrderConfig, nowTs: string): string | null {
  if (config.killSwitchEnabled === true) return "KILL_SWITCH_ENABLED";
  if (intent.status === "expired") return "TRADE_INTENT_EXPIRED";
  if (intent.status === "cancelled") return "TRADE_INTENT_CANCELLED";
  if (intent.status !== "risk_approved") return "TRADE_INTENT_NOT_RISK_APPROVED";
  if (intent.riskDecision.approved !== true) return "RISK_DECISION_NOT_APPROVED";
  if (intent.riskDecision.riskVersion.trim().length === 0) return "RISK_VERSION_MISSING";
  if (!isFinitePositive(intent.suggestedSize)) return "SUGGESTED_SIZE_INVALID";
  if (intent.direction !== "LONG" && intent.direction !== "SHORT") return "DIRECTION_INVALID";
  if (!isFinitePositive(intent.entryPrice)) return "ENTRY_PRICE_INVALID";
  if (!intent.id) return "TRADE_INTENT_ID_MISSING";
  if (intent.expiresAt && Date.parse(intent.expiresAt) <= Date.parse(nowTs)) return "TRADE_INTENT_EXPIRED";
  return null;
}

export function createPaperOrder(intent: TradeIntent, config: CreatePaperOrderConfig): PaperOrder {
  const nowTs = config.nowTs ?? intent.createdAt ?? intent.ts;
  if (!Number.isFinite(Date.parse(nowTs))) throw new Error("paper order nowTs must be a valid timestamp");
  if (!isFiniteNonNegative(config.slippageBps)) throw new Error("slippageBps must be finite and non-negative");
  if (!isFiniteNonNegative(config.feeBps)) throw new Error("feeBps must be finite and non-negative");
  const rejectedBy = rejectionReason(intent, config, nowTs);
  const accepted = rejectedBy === null;

  return {
    tradeIntentId: intent.id ?? "unassigned",
    symbol: intent.symbol,
    exchange: intent.exchange,
    timeframe: intent.timeframe,
    side: intent.direction === "SHORT" ? "SELL" : "BUY",
    orderType: config.orderType ?? "market",
    quantity: accepted ? intent.suggestedSize : 0,
    requestedPrice: intent.entryPrice,
    status: accepted ? "accepted" : "rejected",
    reason: accepted ? "PAPER_ORDER_ACCEPTED" : rejectedBy,
    createdAt: nowTs,
    filledAt: null,
    fillPrice: null,
    slippageBps: config.slippageBps,
    feeBps: config.feeBps,
    metadata: {
      paperOnly: true,
      riskVersion: intent.riskDecision.riskVersion,
      riskDecision: structuredClone(intent.riskDecision),
      sourceSignalIds: [...intent.sourceSignalIds],
      strategyId: intent.strategyId,
      strategyVersion: intent.strategyVersion,
      featureVersion: intent.featureVersion,
      tradeIntentMetadata: structuredClone(intent.metadata),
    },
  };
}
