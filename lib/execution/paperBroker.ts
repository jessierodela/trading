import type { TradeIntent } from "@/lib/tradeIntent";
import { simulatePaperFill } from "./fillSimulator";
import { createPaperOrder } from "./orderManager";
import { openPaperPosition, updatePaperPositionWithBar } from "./paperPosition";
import type {
  CreatePaperOrderConfig,
  PaperFill,
  PaperOrder,
  PaperOrderListFilter,
  PaperOrderStatus,
  PaperPosition,
  PaperPositionBar,
  PaperPositionListFilter,
  PaperPositionStatus,
  PaperPositionUpdateConfig,
} from "./types";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function matchesStatus<T extends string>(value: T, filter: T | T[] | undefined): boolean {
  if (filter === undefined) return true;
  return Array.isArray(filter) ? filter.includes(value) : value === filter;
}

export class InMemoryPaperBroker {
  private readonly orders = new Map<string, PaperOrder>();
  private readonly fills = new Map<string, PaperFill>();
  private readonly positions = new Map<string, PaperPosition>();
  private nextOrderId = 1;
  private nextPositionId = 1;

  async createOrder(intent: TradeIntent, config: CreatePaperOrderConfig): Promise<PaperOrder> {
    const order = createPaperOrder(intent, config);
    const stored = clone({ ...order, id: `paper-order-${this.nextOrderId++}` });
    this.orders.set(stored.id!, stored);
    return clone(stored);
  }

  async fillOrder(orderId: string, ts?: string): Promise<PaperFill> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`paper order not found: ${orderId}`);
    const fill = simulatePaperFill(order, ts);
    const filledOrder: PaperOrder = {
      ...order,
      status: "filled",
      reason: "PAPER_ORDER_FILLED",
      filledAt: fill.ts,
      fillPrice: fill.fillPrice,
    };
    this.orders.set(orderId, clone(filledOrder));
    this.fills.set(orderId, clone(fill));
    return clone(fill);
  }

  async openPosition(intent: TradeIntent, orderId: string): Promise<PaperPosition> {
    const order = this.orders.get(orderId);
    const fill = this.fills.get(orderId);
    if (!order || !fill) throw new Error(`filled paper order not found: ${orderId}`);
    if ([...this.positions.values()].some((position) => position.orderId === orderId)) {
      throw new Error(`paper position already exists for order: ${orderId}`);
    }
    const position = openPaperPosition(intent, order, fill);
    const stored = clone({ ...position, id: `paper-position-${this.nextPositionId++}` });
    this.positions.set(stored.id!, stored);
    return clone(stored);
  }

  async updatePosition(
    positionId: string,
    bar: PaperPositionBar,
    config: PaperPositionUpdateConfig,
  ): Promise<PaperPosition> {
    const position = this.positions.get(positionId);
    if (!position) throw new Error(`paper position not found: ${positionId}`);
    const updated = updatePaperPositionWithBar(position, bar, config);
    this.positions.set(positionId, clone(updated));
    return clone(updated);
  }

  async fetchOrder(id: string): Promise<PaperOrder | null> {
    const order = this.orders.get(id);
    return order ? clone(order) : null;
  }

  async listOrders(filter: PaperOrderListFilter = {}): Promise<PaperOrder[]> {
    return [...this.orders.values()]
      .filter((order) => (
        (filter.tradeIntentId === undefined || order.tradeIntentId === filter.tradeIntentId) &&
        (filter.symbol === undefined || order.symbol === filter.symbol) &&
        matchesStatus<PaperOrderStatus>(order.status, filter.status)
      ))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id ?? "").localeCompare(b.id ?? ""))
      .map(clone);
  }

  async fetchFill(orderId: string): Promise<PaperFill | null> {
    const fill = this.fills.get(orderId);
    return fill ? clone(fill) : null;
  }

  async listFills(): Promise<PaperFill[]> {
    return [...this.fills.values()].sort((a, b) => a.ts.localeCompare(b.ts) || a.orderId.localeCompare(b.orderId)).map(clone);
  }

  async fetchPosition(id: string): Promise<PaperPosition | null> {
    const position = this.positions.get(id);
    return position ? clone(position) : null;
  }

  async listPositions(filter: PaperPositionListFilter = {}): Promise<PaperPosition[]> {
    return [...this.positions.values()]
      .filter((position) => (
        (filter.tradeIntentId === undefined || position.tradeIntentId === filter.tradeIntentId) &&
        (filter.symbol === undefined || position.symbol === filter.symbol) &&
        matchesStatus<PaperPositionStatus>(position.status, filter.status)
      ))
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt) || (a.id ?? "").localeCompare(b.id ?? ""))
      .map(clone);
  }
}
