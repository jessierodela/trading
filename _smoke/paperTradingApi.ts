import {
  createPaperOrderFromIntent,
  fillPaperOrder,
  listPaperPositions,
  mutatePaperPosition,
  paperTradingAuthResult,
  type PaperFill,
  type PaperOrder,
  type PaperPosition,
  type PaperTradingStore,
} from "@/lib/execution";
import { createTradeIntent, type TradeIntent, type TradeIntentListFilter, type TradeIntentStore } from "@/lib/tradeIntent";
import type { StrategySignal } from "@/lib/quant/types";
import type { RiskDecision } from "@/lib/risk/types";
import { RISK_VERSION } from "@/lib/versions";

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.error(`FAIL: ${name}`, detail ?? "");
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function signal(overrides: Partial<StrategySignal> = {}): StrategySignal {
  return {
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
    ts: "2026-06-16T12:00:00.000Z",
    strategyId: "momentum_continuation",
    signalType: "trigger",
    direction: "long",
    confidence: 0.8,
    invalidationPrice: 98,
    stopLoss: 98,
    takeProfit: 104,
    features: {
      symbol: "BTC-USD",
      exchange: "COINBASE",
      timeframe: "1h",
      ts: "2026-06-16T12:00:00.000Z",
      close: 100,
      featureVersion: "features.api.v1",
    },
    reasons: ["api smoke"],
    strategyVersion: "strategy.api.v1",
    featureVersion: "features.api.v1",
    ...overrides,
  };
}

function decision(overrides: Partial<RiskDecision> = {}): RiskDecision {
  return {
    approved: true,
    reason: "Risk approved",
    sizeMultiplier: 0.5,
    maxRiskUsd: 100,
    positionSize: 2,
    stopLoss: 98,
    takeProfit: 104,
    blockedBy: [],
    warnings: ["PAPER_ONLY"],
    riskVersion: RISK_VERSION,
    ...overrides,
  };
}

function makeIntent(id: string, approved: boolean): TradeIntent {
  return {
    ...createTradeIntent({
      signal: signal(),
      riskDecision: approved
        ? decision()
        : decision({
            approved: false,
            reason: "Regime blocked",
            sizeMultiplier: 0,
            positionSize: 0,
            blockedBy: ["REGIME_BLOCKED"],
            warnings: [],
          }),
      entryPrice: 100,
      entryLogic: "Enter at explicit paper API price",
      sourceSignalIds: [`signal-${id}`],
      metadata: { paperOnly: true, regime: "TREND_UP" },
      nowTs: "2026-06-16T12:01:00.000Z",
      expiresAt: "2026-06-16T13:00:00.000Z",
    }),
    id,
  };
}

class FakeIntentStore implements TradeIntentStore {
  private readonly intents = new Map<string, TradeIntent>();

  add(intent: TradeIntent): void {
    this.intents.set(intent.id!, clone(intent));
  }

  async insertIntent(intent: TradeIntent): Promise<TradeIntent> {
    this.add(intent);
    return clone(intent);
  }

  async fetchIntent(id: string): Promise<TradeIntent | null> {
    const intent = this.intents.get(id);
    return intent ? clone(intent) : null;
  }

  async listIntents(filter: TradeIntentListFilter = {}): Promise<TradeIntent[]> {
    return [...this.intents.values()]
      .filter((intent) => (
        (filter.status === undefined || filter.status === intent.status || (Array.isArray(filter.status) && filter.status.includes(intent.status))) &&
        (filter.symbol === undefined || filter.symbol === intent.symbol)
      ))
      .map(clone);
  }
}

class FakePaperStore implements PaperTradingStore {
  readonly orders = new Map<string, PaperOrder>();
  readonly fills = new Map<string, PaperFill>();
  readonly positions = new Map<string, PaperPosition>();
  private nextOrderId = 1;
  private nextPositionId = 1;

  async insertOrder(order: PaperOrder): Promise<PaperOrder> {
    const stored = clone({ ...order, id: order.id ?? `paper-order-${this.nextOrderId++}` });
    this.orders.set(stored.id!, stored);
    return clone(stored);
  }

  async updateOrder(order: PaperOrder): Promise<PaperOrder> {
    if (!order.id || !this.orders.has(order.id)) throw new Error(`paper order not found: ${order.id}`);
    this.orders.set(order.id, clone(order));
    return clone(order);
  }

  async fetchOrder(id: string): Promise<PaperOrder | null> {
    const order = this.orders.get(id);
    return order ? clone(order) : null;
  }

  async listOrders(): Promise<PaperOrder[]> {
    return [...this.orders.values()].map(clone);
  }

  async insertFill(fill: PaperFill): Promise<PaperFill> {
    const order = this.orders.get(fill.orderId);
    if (!order || order.status !== "accepted") throw new Error(`accepted paper order not found: ${fill.orderId}`);
    const stored = clone(fill);
    this.fills.set(fill.orderId, stored);
    return clone(stored);
  }

  async fetchFill(orderId: string): Promise<PaperFill | null> {
    const fill = this.fills.get(orderId);
    return fill ? clone(fill) : null;
  }

  async listFills(): Promise<PaperFill[]> {
    return [...this.fills.values()].map(clone);
  }

  async insertPosition(position: PaperPosition): Promise<PaperPosition> {
    if ([...this.positions.values()].some((stored) => stored.orderId === position.orderId)) {
      throw new Error(`paper position already exists for order: ${position.orderId}`);
    }
    const stored = clone({ ...position, id: position.id ?? `paper-position-${this.nextPositionId++}` });
    this.positions.set(stored.id!, stored);
    return clone(stored);
  }

  async updatePosition(position: PaperPosition): Promise<PaperPosition> {
    if (!position.id || !this.positions.has(position.id)) throw new Error(`paper position not found: ${position.id}`);
    this.positions.set(position.id, clone(position));
    return clone(position);
  }

  async fetchPosition(id: string): Promise<PaperPosition | null> {
    const position = this.positions.get(id);
    return position ? clone(position) : null;
  }

  async listPositions(filter: { tradeIntentId?: string; symbol?: string; status?: PaperPosition["status"] | PaperPosition["status"][] } = {}): Promise<PaperPosition[]> {
    return [...this.positions.values()]
      .filter((position) => (
        (filter.tradeIntentId === undefined || filter.tradeIntentId === position.tradeIntentId) &&
        (filter.symbol === undefined || filter.symbol === position.symbol) &&
        (filter.status === undefined || filter.status === position.status || (Array.isArray(filter.status) && filter.status.includes(position.status)))
      ))
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt))
      .map(clone);
  }

  async aggregateRealizedPnl(): Promise<number> {
    return [...this.positions.values()].reduce((sum, position) => sum + (position.realizedPnl ?? 0), 0);
  }
}

async function main(): Promise<void> {
  const missingSecret = paperTradingAuthResult(new Headers({ "x-internal-api-key": "secret" }), {});
  assert("missing PAPER_TRADING_API_KEY fails closed", missingSecret?.status === 503, missingSecret);

  const unauthorized = paperTradingAuthResult(new Headers({ "x-internal-api-key": "wrong" }), { PAPER_TRADING_API_KEY: "secret" });
  assert("unauthorized request rejected", unauthorized?.status === 401, unauthorized);

  const authorized = paperTradingAuthResult(new Headers({ "x-internal-api-key": "secret" }), { PAPER_TRADING_API_KEY: "secret" });
  assert("authorized request passes auth guard", authorized === null, authorized);

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("network calls forbidden in paper trading API smoke");
  }) as typeof fetch;

  try {
    const intentStore = new FakeIntentStore();
    const paperStore = new FakePaperStore();
    const rejected = makeIntent("rejected", false);
    const approved = makeIntent("approved", true);
    const killed = makeIntent("killed", true);
    intentStore.add(rejected);
    intentStore.add(approved);
    intentStore.add(killed);
    const ctx = { intentStore, paperStore, env: { PAPER_TRADING_API_KEY: "secret" } };

    const rejectedOrder = await createPaperOrderFromIntent(ctx, {
      tradeIntentId: rejected.id,
      requestedPrice: 100,
      slippageBps: 10,
      feeBps: 5,
      orderType: "market",
      nowTs: "2026-06-16T12:02:00.000Z",
    });
    assert("risk_rejected intent cannot create paper order", rejectedOrder.status === 422 && rejectedOrder.body.ok === false, rejectedOrder);
    assert("risk_rejected intent is not persisted as paper order", paperStore.orders.size === 0, [...paperStore.orders.values()]);

    const killedOrder = await createPaperOrderFromIntent({
      intentStore,
      paperStore,
      env: { PAPER_TRADING_API_KEY: "secret", PAPER_TRADING_KILL_SWITCH: "true" },
    }, {
      tradeIntentId: killed.id,
      requestedPrice: 100,
      slippageBps: 10,
      feeBps: 5,
    });
    assert("kill switch blocks paper order creation", killedOrder.status === 423 && killedOrder.body.ok === false, killedOrder);

    const created = await createPaperOrderFromIntent(ctx, {
      tradeIntentId: approved.id,
      requestedPrice: 100,
      slippageBps: 10,
      feeBps: 5,
      orderType: "market",
      nowTs: "2026-06-16T12:02:00.000Z",
    });
    assert("risk_approved intent can create paper order", created.status === 201 && created.body.ok === true, created);
    const order = created.body.ok ? created.body.order : null;
    assert("paper order response includes paperOnly metadata", created.body.paperOnly === true && order?.metadata.paperOnly === true, created.body);

    const afterCreatePositions = await listPaperPositions(ctx, { status: "open" });
    assert("creating order does not open a position", afterCreatePositions.body.ok === true && afterCreatePositions.body.openPositions.length === 0, afterCreatePositions);

    const filled = await fillPaperOrder(ctx, {
      orderId: order?.id,
      fillTs: "2026-06-16T12:03:00.000Z",
    });
    const filledBody = filled.body.ok ? filled.body : null;
    assert("accepted order can be filled", filled.status === 200 && filledBody?.order.status === "filled", filled);
    assert("fill response includes paperOnly metadata", filledBody?.paperOnly === true && filledBody.order.metadata.paperOnly === true, filled.body);

    const afterFillPositions = await listPaperPositions(ctx, { status: "open" });
    assert("filling order does not open a position", afterFillPositions.body.ok === true && afterFillPositions.body.openPositions.length === 0, afterFillPositions);

    const opened = await mutatePaperPosition(ctx, {
      action: "open_from_fill",
      tradeIntentId: approved.id,
      orderId: order?.id,
    });
    const openedBody = opened.body.ok ? opened.body : null;
    assert("filled order can open position", opened.status === 201 && openedBody?.position.status === "open", opened);
    assert("position response includes paperOnly metadata", openedBody?.paperOnly === true && openedBody.position.metadata.paperOnly === true, opened.body);

    const positionId = openedBody?.position.id;
    const marked = await mutatePaperPosition(ctx, {
      action: "update_with_bar",
      positionId,
      bar: {
        symbol: "BTC-USD",
        exchange: "COINBASE",
        ts: "2026-06-16T13:00:00.000Z",
        open: 100.5,
        high: 101.5,
        low: 100,
        close: 101,
      },
      slippageBps: 10,
      feeBps: 5,
    });
    assert("position can be updated with bar", marked.status === 200 && marked.body.ok === true && marked.body.position.status === "open" && marked.body.position.markPrice === 101, marked);

    const openList = await listPaperPositions(ctx, { status: "open", symbol: "BTC-USD", limit: "5" });
    assert("GET positions returns open positions", openList.body.ok === true && openList.body.openPositions.length === 1 && openList.body.summary.openCount === 1, openList);

    const closed = await mutatePaperPosition(ctx, {
      action: "manual_close",
      positionId,
      manualClosePrice: 102,
      manualCloseTs: "2026-06-16T13:05:00.000Z",
      slippageBps: 10,
      feeBps: 5,
    });
    assert("position can be manually closed", closed.status === 200 && closed.body.ok === true && closed.body.position.status === "closed", closed);

    const closedList = await listPaperPositions(ctx, { status: "closed", symbol: "BTC-USD" });
    const closedListBody = closedList.body.ok ? closedList.body : null;
    assert("GET positions returns closed positions", closedListBody?.closedPositions.length === 1 && closedListBody.summary.closedCount === 1, closedList);
    assert("GET positions includes PnL and fees summary", Number.isFinite(closedListBody?.summary.totalRealizedPnl) && (closedListBody?.summary.totalFees ?? 0) > 0, closedList);
    assert("responses include paperOnly metadata", closedListBody?.paperOnly === true && closedListBody.closedPositions[0].metadata.paperOnly === true, closedList.body);

    assert("API never calls fetch/broker/exchange", fetchCalls === 0, fetchCalls);
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`} (${passed} passed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
