import {
  closePaperPositionManually,
  createPaperTradeFromSignal,
  monitorPaperPositions,
  runPaperTradingReadinessChecks,
  type PaperFill,
  type PaperOrder,
  type PaperPosition,
  type PaperTradingStore,
} from "@/lib/execution";
import { createPaperTradingDashboardData } from "@/lib/dashboard/paperTrading";
import type { PaperOrderListFilter, PaperPositionListFilter, PaperPositionStatus } from "@/lib/execution/types";
import type { StrategySignal } from "@/lib/quant/types";
import type { RiskConfig } from "@/lib/risk/types";
import { InMemoryTradeIntentStore } from "@/lib/tradeIntent";
import { FEATURE_VERSION, RISK_VERSION, STRATEGY_VERSIONS } from "@/lib/versions";

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

function matchesStatus<T extends string>(value: T, filter: T | T[] | undefined): boolean {
  if (filter === undefined) return true;
  return Array.isArray(filter) ? filter.includes(value) : value === filter;
}

class FakePaperTradingStore implements PaperTradingStore {
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

  async listOrders(filter: PaperOrderListFilter = {}): Promise<PaperOrder[]> {
    return [...this.orders.values()]
      .filter((order) => (
        (filter.tradeIntentId === undefined || filter.tradeIntentId === order.tradeIntentId) &&
        (filter.symbol === undefined || filter.symbol === order.symbol) &&
        matchesStatus(order.status, filter.status)
      ))
      .map(clone);
  }

  async insertFill(fill: PaperFill): Promise<PaperFill> {
    const order = this.orders.get(fill.orderId);
    if (!order || order.status !== "accepted") throw new Error(`accepted paper order not found: ${fill.orderId}`);
    this.fills.set(fill.orderId, clone(fill));
    return clone(fill);
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

  async listPositions(filter: PaperPositionListFilter = {}): Promise<PaperPosition[]> {
    return [...this.positions.values()]
      .filter((position) => (
        (filter.tradeIntentId === undefined || filter.tradeIntentId === position.tradeIntentId) &&
        (filter.symbol === undefined || filter.symbol === position.symbol) &&
        matchesStatus<PaperPositionStatus>(position.status, filter.status)
      ))
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt) || (a.id ?? "").localeCompare(b.id ?? ""))
      .map(clone);
  }

  async aggregateRealizedPnl(): Promise<number> {
    return [...this.positions.values()].reduce((sum, position) => sum + (position.realizedPnl ?? 0), 0);
  }
}

function riskConfig(overrides: Partial<RiskConfig> = {}): RiskConfig {
  return {
    enabled: true,
    maxRiskPerTradePct: 0.01,
    maxDailyLossPct: 0.03,
    maxWeeklyLossPct: 0.08,
    maxOpenPositions: 3,
    maxSymbolExposurePct: 1,
    maxPortfolioExposurePct: 1,
    minRegimeReliability: 0.5,
    blockedRegimes: [],
    allowLong: true,
    allowShort: true,
    allowDefaultStopFallback: true,
    defaultStopLossPct: 0.02,
    defaultTakeProfitPct: 0.04,
    maxLeverage: 1,
    staleSignalMaxAgeMs: 60 * 60 * 1000,
    duplicateCooldownMs: 0,
    maxConsecutiveLosses: 3,
    highVolSizeMultiplier: 0.5,
    chopSizeMultiplier: 0.25,
    newsShockBlocksTrading: true,
    killSwitchEnabled: false,
    maxOpenPositionDrawdownPct: 0.05,
    ...overrides,
  };
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
    confidence: 0.87,
    invalidationPrice: 98,
    stopLoss: 98,
    takeProfit: 104,
    features: {
      symbol: "BTC-USD",
      exchange: "COINBASE",
      timeframe: "1h",
      ts: "2026-06-16T12:00:00.000Z",
      close: 100,
      featureVersion: FEATURE_VERSION,
    },
    reasons: ["P7E workflow smoke trigger"],
    strategyVersion: STRATEGY_VERSIONS.momentumContinuation,
    featureVersion: FEATURE_VERSION,
    ...overrides,
  };
}

async function createStores(): Promise<{
  intentStore: InMemoryTradeIntentStore;
  paperStore: FakePaperTradingStore;
}> {
  return {
    intentStore: new InMemoryTradeIntentStore(),
    paperStore: new FakePaperTradingStore(),
  };
}

async function runWorkflowSmoke(): Promise<void> {
  console.log("\n=== paper trading workflow ===");
  const stores = await createStores();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("network calls forbidden in P7E workflow smoke");
  }) as typeof fetch;

  try {
    const rejected = await createPaperTradeFromSignal({
      stores,
      signal: signal({ ts: "2026-06-16T12:00:00.000Z" }),
      regime: { regime: "TREND_UP", reliability: 0.92, ts: "2026-06-16T12:00:00.000Z" },
      accountEquity: 10_000,
      riskConfig: riskConfig({ blockedRegimes: ["TREND_UP"] }),
      slippageBps: 10,
      feeBps: 5,
      sourceSignalIds: ["signal-rejected"],
      nowTs: "2026-06-16T12:01:00.000Z",
    });
    assert("risk rejected workflow persists rejected intent", rejected.stage === "risk_rejected" && !!rejected.tradeIntent.id, rejected);
    assert("risk rejected workflow does not create order", rejected.order === null && stores.paperStore.orders.size === 0, rejected);

    const opened = await createPaperTradeFromSignal({
      stores,
      signal: signal(),
      regime: { regime: "TREND_UP", reliability: 0.92, ts: "2026-06-16T12:00:00.000Z" },
      accountEquity: 10_000,
      riskConfig: riskConfig(),
      slippageBps: 10,
      feeBps: 5,
      sourceSignalIds: ["signal-approved"],
      nowTs: "2026-06-16T12:01:00.000Z",
      fillTs: "2026-06-16T12:02:00.000Z",
      expiresAt: "2026-06-16T13:00:00.000Z",
    });
    assert("approved signal opens paper position", opened.ok && opened.stage === "position_opened" && opened.position?.status === "open", opened);
    assert("workflow persists trade intent", !!await stores.intentStore.fetchIntent(opened.tradeIntent.id!), opened.tradeIntent);
    assert("workflow persists filled paper order", !!opened.order?.id && (await stores.paperStore.fetchOrder(opened.order.id))?.status === "filled", opened.order);
    assert("workflow persists deterministic fill", !!opened.order?.id && (await stores.paperStore.fetchFill(opened.order.id))?.fillPrice === opened.fill?.fillPrice, opened.fill);
    assert("workflow persists open position", !!opened.position?.id && (await stores.paperStore.fetchPosition(opened.position.id))?.status === "open", opened.position);
    assert("position carries paper/risk lineage", opened.position?.metadata.paperOnly === true && opened.position.metadata.riskVersion === RISK_VERSION, opened.position?.metadata);

    const marked = await monitorPaperPositions({
      stores,
      bar: {
        symbol: "BTC-USD",
        exchange: "COINBASE",
        ts: "2026-06-16T13:00:00.000Z",
        open: 100.5,
        high: 101.5,
        low: 99.5,
        close: 101,
      },
      slippageBps: 10,
      feeBps: 5,
    });
    assert("explicit monitoring updates open position mark", marked.updatedPositions.length === 1 && marked.updatedPositions[0].status === "open" && marked.updatedPositions[0].markPrice === 101, marked);

    const closedByTarget = await monitorPaperPositions({
      stores,
      bar: {
        symbol: "BTC-USD",
        exchange: "COINBASE",
        ts: "2026-06-16T14:00:00.000Z",
        open: 101,
        high: 105,
        low: 100.5,
        close: 104,
      },
      slippageBps: 10,
      feeBps: 5,
      stopFirst: true,
    });
    const targetPosition = closedByTarget.closedPositions[0];
    assert("monitoring closes on take profit", targetPosition?.status === "closed" && targetPosition.metadata.closeReason === "take_profit", targetPosition);
    assert("closed target trade has realized PnL and fees", (targetPosition?.realizedPnl ?? 0) > 0 && (targetPosition?.fees ?? 0) > 0, targetPosition);

    const manualSource = await createPaperTradeFromSignal({
      stores,
      signal: signal({ ts: "2026-06-16T15:00:00.000Z", features: { ...signal().features, ts: "2026-06-16T15:00:00.000Z" } }),
      regime: { regime: "TREND_UP", reliability: 0.9, ts: "2026-06-16T15:00:00.000Z" },
      accountEquity: 10_000,
      riskConfig: riskConfig(),
      slippageBps: 10,
      feeBps: 5,
      sourceSignalIds: ["signal-manual"],
      nowTs: "2026-06-16T15:01:00.000Z",
      fillTs: "2026-06-16T15:02:00.000Z",
    });
    const manualClosed = await closePaperPositionManually({
      stores,
      positionId: manualSource.position!.id!,
      manualClosePrice: 102,
      manualCloseTs: "2026-06-16T15:30:00.000Z",
      slippageBps: 10,
      feeBps: 5,
    });
    assert("manual close is explicit and persisted", manualClosed.status === "closed" && manualClosed.metadata.closeReason === "manual", manualClosed);

    const killed = await createPaperTradeFromSignal({
      stores,
      signal: signal({ ts: "2026-06-16T16:00:00.000Z", features: { ...signal().features, ts: "2026-06-16T16:00:00.000Z" } }),
      regime: { regime: "TREND_UP", reliability: 0.9, ts: "2026-06-16T16:00:00.000Z" },
      accountEquity: 10_000,
      riskConfig: riskConfig({ killSwitchEnabled: true }),
      slippageBps: 10,
      feeBps: 5,
      sourceSignalIds: ["signal-killed"],
      nowTs: "2026-06-16T16:01:00.000Z",
    });
    assert("kill switch blocks new workflow trade before order", killed.stage === "risk_rejected" && killed.order === null && killed.riskDecision.blockedBy.includes("KILL_SWITCH_ENABLED"), killed);

    const dashboardData = createPaperTradingDashboardData(
      await stores.paperStore.listPositions({ status: "open" }),
      await stores.paperStore.listPositions({ status: "closed" }),
    );
    assert("dashboard can see persisted closed trades", dashboardData.state === "ready" && dashboardData.closedPositions.length === 2 && dashboardData.summary.closedTradeCount === 2, dashboardData);
    assert("dashboard summary exports realized PnL", Number.isFinite(dashboardData.summary.totalRealizedPnl) && dashboardData.summary.totalFees > 0, dashboardData.summary);
    assert("workflow never calls live broker or exchange APIs", fetchCalls === 0, fetchCalls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function runReadinessSmoke(): Promise<void> {
  console.log("\n=== paper trading readiness ===");
  const readyEnv = {
    DATABASE_URL: "postgres://paper-readiness",
    PAPER_TRADING_API_KEY: "paper-secret",
    PAPER_TRADING_KILL_SWITCH: "false",
  };
  const ready = await runPaperTradingReadinessChecks({
    riskConfig: riskConfig(),
    env: readyEnv,
    generatedAt: "2026-06-16T17:00:00.000Z",
    dbCheck: async () => ({
      postgresReachable: true,
      paperTablesReadableWritable: true,
      message: "smoke db ready",
    }),
    dashboardCheck: async () => ({
      canReadPositions: true,
      message: "smoke dashboard ready",
    }),
  });
  assert("readiness passes with required paper run dependencies", ready.ok && ready.checks.every((item) => item.ok), ready);

  const missingAuth = await runPaperTradingReadinessChecks({
    riskConfig: riskConfig(),
    env: {
      DATABASE_URL: "postgres://paper-readiness",
      PAPER_TRADING_KILL_SWITCH: "false",
    },
    dbCheck: async () => ({
      postgresReachable: true,
      paperTablesReadableWritable: true,
      message: "smoke db ready",
    }),
    dashboardCheck: async () => ({
      canReadPositions: true,
      message: "smoke dashboard ready",
    }),
    liveBrokerImportScanner: async () => ({ found: false, matches: [] }),
  });
  assert("readiness fails closed when paper API auth is missing", !missingAuth.ok && missingAuth.checks.some((item) => item.id === "paper_api_auth_configured" && !item.ok), missingAuth);

  const missingDb = await runPaperTradingReadinessChecks({
    riskConfig: riskConfig(),
    env: {
      PAPER_TRADING_API_KEY: "paper-secret",
      PAPER_TRADING_KILL_SWITCH: "false",
    },
    dbCheck: async () => ({
      postgresReachable: false,
      paperTablesReadableWritable: false,
      message: "db unavailable",
    }),
    dashboardCheck: async () => ({
      canReadPositions: false,
      message: "dashboard unavailable without db",
    }),
    liveBrokerImportScanner: async () => ({ found: false, matches: [] }),
  });
  assert("readiness fails closed when Postgres is unavailable", !missingDb.ok && missingDb.checks.some((item) => item.id === "postgres_reachable" && !item.ok), missingDb);

  const liveImport = await runPaperTradingReadinessChecks({
    riskConfig: riskConfig(),
    env: readyEnv,
    dbCheck: async () => ({
      postgresReachable: true,
      paperTablesReadableWritable: true,
      message: "smoke db ready",
    }),
    dashboardCheck: async () => ({
      canReadPositions: true,
      message: "smoke dashboard ready",
    }),
    liveBrokerImportScanner: async () => ({
      found: true,
      matches: ["lib/execution/example.ts: submitLiveOrder"],
    }),
  });
  assert("readiness fails closed if live broker imports appear", !liveImport.ok && liveImport.checks.some((item) => item.id === "no_live_broker_clients_imported" && !item.ok), liveImport);

  const liveEnvPresent = await runPaperTradingReadinessChecks({
    riskConfig: riskConfig(),
    env: {
      ...readyEnv,
      ALPACA_API_KEY: "present-but-ignored",
    },
    dbCheck: async () => ({
      postgresReachable: true,
      paperTablesReadableWritable: true,
      message: "smoke db ready",
    }),
    dashboardCheck: async () => ({
      canReadPositions: true,
      message: "smoke dashboard ready",
    }),
    liveBrokerImportScanner: async () => ({ found: false, matches: [] }),
  });
  const liveEnvCheck = liveEnvPresent.checks.find((item) => item.id === "no_live_broker_env_required");
  assert("readiness does not require live broker env vars", liveEnvPresent.ok && liveEnvCheck?.ok === true && liveEnvCheck.severity === "warning", liveEnvPresent);
}

async function main(): Promise<void> {
  await runWorkflowSmoke();
  await runReadinessSmoke();

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`} (${passed} passed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
