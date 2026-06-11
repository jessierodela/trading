import type { Bar } from "@/lib/quant/types";

export type PaperOrderStatus = "created" | "accepted" | "rejected" | "filled" | "cancelled";
export type PaperOrderSide = "BUY" | "SELL";
export type PaperOrderType = "market" | "limit";

export interface PaperOrder {
  id?: string;
  tradeIntentId: string;
  symbol: string;
  exchange: string;
  timeframe: string;
  side: PaperOrderSide;
  orderType: PaperOrderType;
  quantity: number;
  requestedPrice: number;
  status: PaperOrderStatus;
  reason: string;
  createdAt: string;
  filledAt: string | null;
  fillPrice: number | null;
  slippageBps: number;
  feeBps: number;
  metadata: Record<string, unknown>;
}

export type PaperPositionStatus = "open" | "closed";

export interface PaperPosition {
  id?: string;
  tradeIntentId: string;
  orderId: string;
  symbol: string;
  exchange: string;
  direction: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  markPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: string;
  closedAt: string | null;
  exitPrice: number | null;
  realizedPnl: number | null;
  unrealizedPnl: number;
  fees: number;
  status: PaperPositionStatus;
  metadata: Record<string, unknown>;
}

export interface PaperFill {
  orderId: string;
  symbol: string;
  ts: string;
  quantity: number;
  requestedPrice: number;
  fillPrice: number;
  slippageCost: number;
  fee: number;
}

export interface CreatePaperOrderConfig {
  orderType?: PaperOrderType;
  slippageBps: number;
  feeBps: number;
  nowTs?: string;
  killSwitchEnabled?: boolean;
}

export interface PaperPositionUpdateConfig {
  slippageBps: number;
  feeBps: number;
  stopFirst?: true;
  manualClosePrice?: number;
  manualCloseTs?: string;
}

export type PaperPositionBar = Pick<Bar, "symbol" | "exchange" | "ts" | "open" | "high" | "low" | "close">;

export interface PaperOrderListFilter {
  tradeIntentId?: string;
  symbol?: string;
  status?: PaperOrderStatus | PaperOrderStatus[];
}

export interface PaperPositionListFilter {
  tradeIntentId?: string;
  symbol?: string;
  status?: PaperPositionStatus | PaperPositionStatus[];
}
