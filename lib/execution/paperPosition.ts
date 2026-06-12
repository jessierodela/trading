import type { TradeIntent } from "@/lib/tradeIntent";
import type {
  PaperFill,
  PaperOrder,
  PaperPosition,
  PaperPositionBar,
  PaperPositionUpdateConfig,
} from "./types";

function directionalPnl(direction: PaperPosition["direction"], entry: number, exit: number, quantity: number): number {
  return direction === "LONG" ? (exit - entry) * quantity : (entry - exit) * quantity;
}

export function openPaperPosition(intent: TradeIntent, order: PaperOrder, fill: PaperFill): PaperPosition {
  if (!intent.id || order.tradeIntentId !== intent.id) throw new Error("paper order trade intent lineage mismatch");
  if (!order.id || order.status !== "filled") throw new Error("filled paper order is required to open a position");
  if (fill.orderId !== order.id) throw new Error("paper fill order lineage mismatch");
  if (fill.symbol !== order.symbol || fill.symbol !== intent.symbol) throw new Error("paper fill symbol lineage mismatch");
  if (!Number.isFinite(fill.quantity) || fill.quantity <= 0 || fill.quantity !== order.quantity) {
    throw new Error("paper fill quantity must match the filled order");
  }
  if (!Number.isFinite(fill.fillPrice) || fill.fillPrice <= 0) throw new Error("paper fill price must be positive");
  if (intent.status !== "risk_approved" || intent.riskDecision.approved !== true) {
    throw new Error("risk-approved trade intent is required to open a paper position");
  }
  if (intent.riskDecision.riskVersion.trim().length === 0) throw new Error("risk version is required to open a paper position");

  return {
    tradeIntentId: intent.id,
    orderId: order.id,
    symbol: intent.symbol,
    exchange: intent.exchange,
    direction: intent.direction,
    quantity: fill.quantity,
    entryPrice: fill.fillPrice,
    markPrice: fill.fillPrice,
    stopLoss: intent.stopLoss,
    takeProfit: intent.takeProfit,
    openedAt: fill.ts,
    closedAt: null,
    exitPrice: null,
    realizedPnl: null,
    unrealizedPnl: -fill.fee,
    fees: fill.fee,
    status: "open",
    metadata: {
      paperOnly: true,
      riskVersion: intent.riskDecision.riskVersion,
      riskDecision: structuredClone(intent.riskDecision),
      sourceSignalIds: [...intent.sourceSignalIds],
      strategyId: intent.strategyId,
      strategyVersion: intent.strategyVersion,
      featureVersion: intent.featureVersion,
      tradeIntentMetadata: structuredClone(intent.metadata),
      requestedEntryPrice: fill.requestedPrice,
      entrySlippageCost: fill.slippageCost,
      entryFee: fill.fee,
    },
  };
}

export function updatePaperPositionWithBar(
  position: PaperPosition,
  bar: PaperPositionBar,
  config: PaperPositionUpdateConfig,
): PaperPosition {
  if (position.status === "closed") return structuredClone(position);
  if (bar.symbol !== position.symbol || bar.exchange !== position.exchange) {
    throw new Error("paper position bar instrument mismatch");
  }
  if (!Number.isFinite(config.slippageBps) || config.slippageBps < 0) throw new Error("slippageBps must be finite and non-negative");
  if (!Number.isFinite(config.feeBps) || config.feeBps < 0) throw new Error("feeBps must be finite and non-negative");
  if (!Number.isFinite(Date.parse(bar.ts))) throw new Error("paper position bar timestamp must be valid");
  if (config.manualCloseTs !== undefined && !Number.isFinite(Date.parse(config.manualCloseTs))) {
    throw new Error("manualCloseTs must be a valid timestamp");
  }

  let closeReason: "manual" | "stop_loss" | "take_profit" | null = null;
  let requestedExitPrice: number | null = null;
  if (config.manualClosePrice !== undefined) {
    if (!Number.isFinite(config.manualClosePrice) || config.manualClosePrice <= 0) {
      throw new Error("manualClosePrice must be a finite positive number");
    }
    closeReason = "manual";
    requestedExitPrice = config.manualClosePrice;
  } else if (position.direction === "LONG") {
    if (position.stopLoss !== null && bar.low <= position.stopLoss) {
      closeReason = "stop_loss";
      requestedExitPrice = position.stopLoss;
    } else if (position.takeProfit !== null && bar.high >= position.takeProfit) {
      closeReason = "take_profit";
      requestedExitPrice = position.takeProfit;
    }
  } else if (position.stopLoss !== null && bar.high >= position.stopLoss) {
    closeReason = "stop_loss";
    requestedExitPrice = position.stopLoss;
  } else if (position.takeProfit !== null && bar.low <= position.takeProfit) {
    closeReason = "take_profit";
    requestedExitPrice = position.takeProfit;
  }

  if (closeReason === null || requestedExitPrice === null) {
    return {
      ...structuredClone(position),
      markPrice: bar.close,
      unrealizedPnl: directionalPnl(position.direction, position.entryPrice, bar.close, position.quantity) - position.fees,
    };
  }

  const factor = config.slippageBps / 10_000;
  const exitPrice = position.direction === "LONG"
    ? requestedExitPrice * (1 - factor)
    : requestedExitPrice * (1 + factor);
  const exitSlippageCost = Math.abs(exitPrice - requestedExitPrice) * position.quantity;
  const exitFee = Math.abs(exitPrice * position.quantity) * config.feeBps / 10_000;
  const fees = position.fees + exitFee;
  const grossPnl = directionalPnl(position.direction, position.entryPrice, exitPrice, position.quantity);
  const realizedPnl = grossPnl - fees;

  return {
    ...structuredClone(position),
    markPrice: exitPrice,
    closedAt: config.manualCloseTs ?? bar.ts,
    exitPrice,
    realizedPnl,
    unrealizedPnl: 0,
    fees,
    status: "closed",
    metadata: {
      ...structuredClone(position.metadata),
      closeReason,
      requestedExitPrice,
      grossPnl,
      exitFee,
      exitSlippageCost,
      totalSlippageCost: Number(position.metadata.entrySlippageCost ?? 0) + exitSlippageCost,
      netPnl: realizedPnl,
    },
  };
}
