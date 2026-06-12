import type { PaperFill, PaperOrder } from "./types";

export function simulatePaperFill(order: PaperOrder, ts = order.createdAt): PaperFill {
  if (!order.id) throw new Error("paper order id is required before fill simulation");
  if (order.status !== "accepted") throw new Error(`paper order must be accepted before fill simulation: ${order.status}`);
  if (!Number.isFinite(Date.parse(ts))) throw new Error("fill timestamp must be valid");
  const slippageFactor = order.slippageBps / 10_000;
  const fillPrice = order.side === "BUY"
    ? order.requestedPrice * (1 + slippageFactor)
    : order.requestedPrice * (1 - slippageFactor);
  const notional = Math.abs(fillPrice * order.quantity);

  return {
    orderId: order.id,
    symbol: order.symbol,
    ts,
    quantity: order.quantity,
    requestedPrice: order.requestedPrice,
    fillPrice,
    slippageCost: Math.abs(fillPrice - order.requestedPrice) * order.quantity,
    fee: notional * order.feeBps / 10_000,
  };
}
