import {
  createPaperOrder,
  InMemoryPaperBroker,
  openPaperPosition,
  simulatePaperFill,
  updatePaperPositionWithBar,
  type PaperOrder,
  type PaperPosition,
  type PaperPositionBar,
} from "@/lib/execution";
import { createTradeIntent, type TradeIntent } from "@/lib/tradeIntent";
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

function near(actual: number | null, expected: number, tolerance = 1e-8): boolean {
  return actual !== null && Math.abs(actual - expected) <= tolerance;
}

function signal(direction: "long" | "short" = "long"): StrategySignal {
  return {
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
    ts: "2026-06-11T12:00:00.000Z",
    strategyId: "momentum_continuation",
    signalType: "trigger",
    direction,
    confidence: 0.9,
    stopLoss: direction === "long" ? 98 : 102,
    invalidationPrice: direction === "long" ? 98 : 102,
    takeProfit: direction === "long" ? 104 : 96,
    features: {
      symbol: "BTC-USD",
      exchange: "COINBASE",
      timeframe: "1h",
      ts: "2026-06-11T12:00:00.000Z",
      close: 100,
      featureVersion: "features.test.v1",
    },
    reasons: ["paper smoke signal"],
    strategyVersion: "strategy.test.v1",
    featureVersion: "features.test.v1",
  };
}

function decision(direction: "long" | "short" = "long", approved = true): RiskDecision {
  return {
    approved,
    reason: approved ? "Risk approved" : "Risk rejected",
    sizeMultiplier: approved ? 1 : 0,
    maxRiskUsd: 100,
    positionSize: approved ? 10 : 0,
    stopLoss: direction === "long" ? 98 : 102,
    takeProfit: direction === "long" ? 104 : 96,
    blockedBy: approved ? [] : ["REGIME_BLOCKED"],
    warnings: [],
    riskVersion: RISK_VERSION,
  };
}

function intent(direction: "long" | "short" = "long", approved = true, id = "intent-1"): TradeIntent {
  return {
    ...createTradeIntent({
      signal: signal(direction),
      riskDecision: decision(direction, approved),
      entryPrice: 100,
      entryLogic: "Paper simulation at explicit requested price",
      sourceSignalIds: ["signal-1"],
      metadata: { regime: "TREND_UP", featureSnapshot: { close: 100 } },
      nowTs: "2026-06-11T12:01:00.000Z",
      expiresAt: "2026-06-11T14:00:00.000Z",
    }),
    id,
  };
}

function orderConfig(overrides: Partial<Parameters<typeof createPaperOrder>[1]> = {}) {
  return {
    slippageBps: 10,
    feeBps: 10,
    nowTs: "2026-06-11T12:02:00.000Z",
    ...overrides,
  };
}

function bar(fields: Partial<PaperPositionBar> = {}): PaperPositionBar {
  return {
    symbol: "BTC-USD",
    exchange: "COINBASE",
    ts: "2026-06-11T13:00:00.000Z",
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    ...fields,
  };
}

function filledOrder(tradeIntent: TradeIntent, id = "paper-order-1"): { order: PaperOrder; fill: ReturnType<typeof simulatePaperFill> } {
  const accepted = { ...createPaperOrder(tradeIntent, orderConfig()), id };
  const fill = simulatePaperFill(accepted, "2026-06-11T12:03:00.000Z");
  return {
    order: { ...accepted, status: "filled", reason: "PAPER_ORDER_FILLED", filledAt: fill.ts, fillPrice: fill.fillPrice },
    fill,
  };
}

function openedPosition(direction: "long" | "short" = "long"): PaperPosition {
  const tradeIntent = intent(direction, true, `intent-${direction}`);
  const { order, fill } = filledOrder(tradeIntent, `order-${direction}`);
  return { ...openPaperPosition(tradeIntent, order, fill), id: `position-${direction}` };
}

function testOrderGuards(): void {
  console.log("\n=== paper order guards ===");
  const rejected = createPaperOrder(intent("long", false, "intent-rejected"), orderConfig());
  assert("rejects risk_rejected trade intent", rejected.status === "rejected" && rejected.reason === "TRADE_INTENT_NOT_RISK_APPROVED", rejected);

  const missingVersion = intent("long", true, "intent-missing-version");
  missingVersion.riskDecision.riskVersion = "";
  const versionRejected = createPaperOrder(missingVersion, orderConfig());
  assert("rejects approved intent with missing riskVersion", versionRejected.reason === "RISK_VERSION_MISSING", versionRejected);

  const zeroSize = intent("long", true, "intent-zero");
  zeroSize.suggestedSize = 0;
  const zeroRejected = createPaperOrder(zeroSize, orderConfig());
  assert("rejects approved intent with suggestedSize <= 0", zeroRejected.reason === "SUGGESTED_SIZE_INVALID", zeroRejected);

  const expired = { ...intent("long", true, "intent-expired"), status: "expired" as const };
  assert("rejects expired intent", createPaperOrder(expired, orderConfig()).reason === "TRADE_INTENT_EXPIRED");
  const cancelled = { ...intent("long", true, "intent-cancelled"), status: "cancelled" as const };
  assert("rejects cancelled intent", createPaperOrder(cancelled, orderConfig()).reason === "TRADE_INTENT_CANCELLED");

  const killed = createPaperOrder(intent("long", true, "intent-killed"), orderConfig({ killSwitchEnabled: true }));
  assert("kill switch blocks new paper order", killed.reason === "KILL_SWITCH_ENABLED", killed);

  const accepted = createPaperOrder(intent(), orderConfig());
  assert("creates paper order from risk_approved intent", accepted.status === "accepted" && accepted.quantity === 10, accepted);
  assert("paper order retains risk lineage", (accepted.metadata.riskDecision as RiskDecision).riskVersion === RISK_VERSION, accepted.metadata);
}

function testFillAndOpen(): void {
  console.log("\n=== fill and position open ===");
  const tradeIntent = intent();
  const first = { ...createPaperOrder(tradeIntent, orderConfig()), id: "paper-order-1" };
  const fillA = simulatePaperFill(first, "2026-06-11T12:03:00.000Z");
  const fillB = simulatePaperFill(first, "2026-06-11T12:03:00.000Z");
  assert("fills paper order deterministically", JSON.stringify(fillA) === JSON.stringify(fillB), fillA);
  assert("BUY fill applies adverse slippage", fillA.fillPrice > fillA.requestedPrice, fillA);
  assert("fill calculates fee", fillA.fee > 0, fillA);
  const shortOrder = { ...createPaperOrder(intent("short", true, "intent-short-fill"), orderConfig()), id: "paper-order-short" };
  const shortFill = simulatePaperFill(shortOrder, "2026-06-11T12:03:00.000Z");
  assert("SELL fill applies adverse slippage", shortFill.fillPrice < shortFill.requestedPrice, shortFill);

  const filled: PaperOrder = { ...first, status: "filled", reason: "PAPER_ORDER_FILLED", filledAt: fillA.ts, fillPrice: fillA.fillPrice };
  const position = openPaperPosition(tradeIntent, filled, fillA);
  assert("opens paper position from fill", position.status === "open", position);
  assert("position preserves tradeIntentId", position.tradeIntentId === tradeIntent.id, position);
  assert("position preserves risk decision metadata", (position.metadata.riskDecision as RiskDecision).riskVersion === RISK_VERSION, position.metadata);
  assert("position preserves strategy lineage", position.metadata.strategyVersion === tradeIntent.strategyVersion, position.metadata);
  assert("position preserves feature snapshot metadata", (position.metadata.tradeIntentMetadata as { featureSnapshot: { close: number } }).featureSnapshot.close === 100, position.metadata);
}

function testPositionMonitoring(): void {
  console.log("\n=== position monitoring ===");
  const long = openedPosition("long");
  const marked = updatePaperPositionWithBar(long, bar({ close: 103 }), { slippageBps: 10, feeBps: 10 });
  assert("calculates unrealized PnL while open", marked.status === "open" && marked.unrealizedPnl > 0, marked);

  const stopped = updatePaperPositionWithBar(long, bar({ low: 97, high: 101, close: 98 }), { slippageBps: 10, feeBps: 10 });
  assert("LONG stop-loss closes position", stopped.status === "closed" && stopped.metadata.closeReason === "stop_loss", stopped);
  assert("calculates realized PnL after close", stopped.realizedPnl !== null && stopped.realizedPnl < 0, stopped);

  const target = updatePaperPositionWithBar(long, bar({ low: 99, high: 105, close: 104 }), { slippageBps: 10, feeBps: 10 });
  assert("LONG take-profit closes position", target.status === "closed" && target.metadata.closeReason === "take_profit", target);
  assert("LONG take-profit is profitable after costs", (target.realizedPnl ?? 0) > 0, target);

  const sameBar = updatePaperPositionWithBar(long, bar({ low: 97, high: 105 }), { slippageBps: 0, feeBps: 0, stopFirst: true });
  assert("same-bar stop-first rule is honored", sameBar.metadata.closeReason === "stop_loss" && sameBar.exitPrice === 98, sameBar);

  const short = openedPosition("short");
  const shortStop = updatePaperPositionWithBar(short, bar({ high: 103, low: 99 }), { slippageBps: 10, feeBps: 10 });
  assert("SHORT stop-loss closes position", shortStop.status === "closed" && shortStop.metadata.closeReason === "stop_loss", shortStop);
  const shortTarget = updatePaperPositionWithBar(short, bar({ high: 101, low: 95 }), { slippageBps: 10, feeBps: 10 });
  assert("SHORT take-profit closes position", shortTarget.status === "closed" && shortTarget.metadata.closeReason === "take_profit", shortTarget);
  assert("SHORT take-profit is profitable after costs", (shortTarget.realizedPnl ?? 0) > 0, shortTarget);

  const manual = updatePaperPositionWithBar(long, bar({ close: 102 }), {
    slippageBps: 0,
    feeBps: 0,
    manualClosePrice: 102,
    manualCloseTs: "2026-06-11T13:05:00.000Z",
  });
  assert("manual close is explicit and deterministic", manual.metadata.closeReason === "manual" && manual.closedAt === "2026-06-11T13:05:00.000Z", manual);
}

async function testBrokerStoreAndBoundary(): Promise<void> {
  console.log("\n=== in-memory broker and safety boundary ===");
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls++;
    throw new Error("network access forbidden in paper smoke");
  }) as typeof fetch;

  try {
    const broker = new InMemoryPaperBroker();
    const tradeIntent = intent();
    const order = await broker.createOrder(tradeIntent, orderConfig());
    const fill = await broker.fillOrder(order.id!, "2026-06-11T12:03:00.000Z");
    const position = await broker.openPosition(tradeIntent, order.id!);
    let duplicatePositionBlocked = false;
    try {
      await broker.openPosition(tradeIntent, order.id!);
    } catch {
      duplicatePositionBlocked = true;
    }
    const closed = await broker.updatePosition(position.id!, bar({ high: 105 }), { slippageBps: 10, feeBps: 10 });

    assert("store can insert fetch and list orders", (await broker.fetchOrder(order.id!))?.status === "filled" && (await broker.listOrders()).length === 1);
    assert("store can insert fetch and list fills", (await broker.fetchFill(order.id!))?.fillPrice === fill.fillPrice && (await broker.listFills()).length === 1);
    assert("store can insert fetch and list positions", (await broker.fetchPosition(position.id!))?.status === "closed" && (await broker.listPositions()).length === 1);
    assert("store filters closed positions", (await broker.listPositions({ status: "closed" })).length === 1 && closed.status === "closed");
    assert("one filled order cannot open duplicate positions", duplicatePositionBlocked);
    assert("does not call broker or exchange APIs", networkCalls === 0, networkCalls);

    const keys = Object.keys(order);
    const forbidden = ["externalOrderId", "brokerOrderId", "accountId", "live", "submittedAt"];
    assert("does not create live order fields", forbidden.every((key) => !keys.includes(key)), keys);
    assert("paper metadata is explicit", order.metadata.paperOnly === true, order.metadata);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main(): Promise<void> {
  testOrderGuards();
  testFillAndOpen();
  testPositionMonitoring();
  await testBrokerStoreAndBoundary();

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`} (${passed} passed)`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
