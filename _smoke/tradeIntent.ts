import { createTradeIntent, InMemoryTradeIntentStore } from "@/lib/tradeIntent";
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

function signal(overrides: Partial<StrategySignal> = {}): StrategySignal {
  return {
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
    ts: "2026-06-11T12:00:00.000Z",
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
      ts: "2026-06-11T12:00:00.000Z",
      close: 100,
      featureVersion: "features.test.v1",
    },
    reasons: ["momentum confirmed"],
    strategyVersion: "strategy.test.v1",
    featureVersion: "features.test.v1",
    ...overrides,
  };
}

function approvedDecision(overrides: Partial<RiskDecision> = {}): RiskDecision {
  return {
    approved: true,
    reason: "Risk approved",
    sizeMultiplier: 0.5,
    maxRiskUsd: 100,
    positionSize: 25,
    stopLoss: 98,
    takeProfit: 104,
    blockedBy: [],
    warnings: ["HIGH_VOL_SIZE_REDUCED"],
    riskVersion: RISK_VERSION,
    ...overrides,
  };
}

function rejectedDecision(overrides: Partial<RiskDecision> = {}): RiskDecision {
  return approvedDecision({
    approved: false,
    reason: "Current regime is blocked",
    sizeMultiplier: 0,
    positionSize: 0,
    blockedBy: ["REGIME_BLOCKED"],
    warnings: [],
    ...overrides,
  });
}

function approvedIntent() {
  return createTradeIntent({
    signal: signal(),
    riskDecision: approvedDecision(),
    entryPrice: 100,
    entryLogic: "Enter on the next simulated bar open",
    sourceSignalIds: ["signal-101", "signal-102"],
    metadata: { simulationOnly: true, nested: { source: "smoke" } },
    nowTs: "2026-06-11T12:01:00.000Z",
    expiresAt: "2026-06-11T13:00:00.000Z",
  });
}

function testFactory(): void {
  console.log("\n=== intent factory ===");
  const approved = approvedIntent();
  assert("creates risk_approved intent from approved decision", approved.status === "risk_approved", approved);
  assert("approved intent carries riskVersion", approved.riskDecision.riskVersion === RISK_VERSION, approved);
  assert("intent preserves signal lineage", approved.sourceSignalIds.join(",") === "signal-101,signal-102", approved);
  assert("intent preserves strategyVersion", approved.strategyVersion === "strategy.test.v1", approved);
  assert("intent preserves featureVersion", approved.featureVersion === "features.test.v1", approved);
  assert("approved intent uses risk positionSize", approved.suggestedSize === 25, approved);
  assert("approved intent preserves risk warning metadata", JSON.stringify(approved.metadata.riskWarnings) === JSON.stringify(["HIGH_VOL_SIZE_REDUCED"]), approved.metadata);

  const rejected = createTradeIntent({
    signal: signal(),
    riskDecision: rejectedDecision(),
    entryPrice: 100,
    entryLogic: "Evaluate simulated entry",
    sourceSignalIds: ["signal-201"],
  });
  assert("creates risk_rejected intent from rejected decision", rejected.status === "risk_rejected", rejected);
  assert("rejected intent carries blockedBy reasons", rejected.riskDecision.blockedBy.includes("REGIME_BLOCKED"), rejected);
  assert("rejected intent copies blockers into metadata", JSON.stringify(rejected.metadata.riskBlockedBy) === JSON.stringify(["REGIME_BLOCKED"]), rejected.metadata);
  assert("rejected intent has suggestedSize zero", rejected.suggestedSize === 0, rejected);
  assert("rejected intent preserves max risk budget", rejected.maxRiskUsd === 100, rejected);
}

function testPurityAndValidation(): void {
  console.log("\n=== purity and validation ===");
  const input = {
    signal: signal(),
    riskDecision: approvedDecision(),
    entryPrice: 100,
    entryLogic: "Simulated entry",
    sourceSignalIds: ["signal-301"],
    metadata: { nested: { value: 1 } },
    nowTs: "2026-06-11T12:01:00.000Z",
  };
  const before = JSON.stringify(input);
  const first = createTradeIntent(input);
  const second = createTradeIntent(input);
  assert("factory is deterministic", JSON.stringify(first) === JSON.stringify(second));
  assert("factory does not mutate input", JSON.stringify(input) === before, input);
  first.riskDecision.blockedBy.push("MUTATED_OUTPUT");
  (first.metadata.nested as { value: number }).value = 2;
  assert("factory output does not alias risk input", input.riskDecision.blockedBy.length === 0, input.riskDecision);
  assert("factory output does not alias metadata input", input.metadata.nested.value === 1, input.metadata);

  let missingVersionBlocked = false;
  try {
    createTradeIntent({ ...input, riskDecision: approvedDecision({ riskVersion: "" }) });
  } catch {
    missingVersionBlocked = true;
  }
  assert("factory requires riskVersion", missingVersionBlocked);

  let noDirectionBlocked = false;
  try {
    createTradeIntent({ ...input, signal: signal({ direction: "none" }) });
  } catch {
    noDirectionBlocked = true;
  }
  assert("factory rejects non-trade direction", noDirectionBlocked);
}

async function testStore(): Promise<void> {
  console.log("\n=== in-memory store ===");
  const store = new InMemoryTradeIntentStore();
  const approved = await store.insertIntent(approvedIntent());
  const rejected = await store.insertIntent(createTradeIntent({
    signal: signal({ symbol: "ETH-USD" }),
    riskDecision: rejectedDecision({ blockedBy: ["KILL_SWITCH_ENABLED"] }),
    entryPrice: 2000,
    entryLogic: "Evaluate simulated entry",
    sourceSignalIds: ["signal-401"],
    nowTs: "2026-06-11T12:02:00.000Z",
  }));

  assert("store assigns deterministic in-memory id", approved.id === "memory-1", approved);
  assert("store inserts second intent", rejected.id === "memory-2", rejected);
  assert("store fetches intent", (await store.fetchIntent("memory-1"))?.strategyId === approved.strategyId);
  assert("store returns null for missing intent", await store.fetchIntent("missing") === null);
  assert("store lists all intents", (await store.listIntents()).length === 2);
  assert("store filters by status", (await store.listIntents({ status: "risk_rejected" })).length === 1);
  assert("store filters by symbol", (await store.listIntents({ symbol: "BTC-USD" })).length === 1);

  const fetched = await store.fetchIntent("memory-1");
  if (fetched) fetched.metadata.changed = true;
  assert("store fetch returns an isolated copy", (await store.fetchIntent("memory-1"))?.metadata.changed === undefined);
}

function testSimulationBoundary(): void {
  console.log("\n=== simulation boundary ===");
  const intent = approvedIntent();
  const keys = Object.keys(intent);
  const forbiddenKeys = ["order", "orderId", "fill", "fills", "position", "positionId", "brokerAccount"];
  assert("no order fill or position objects are created", forbiddenKeys.every((key) => !keys.includes(key)), keys);
  assert("intent status is risk-only", !["submitted", "partially_filled", "filled", "closed", "error"].includes(intent.status));
}

async function main(): Promise<void> {
  testFactory();
  testPurityAndValidation();
  await testStore();
  testSimulationBoundary();

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`} (${passed} passed)`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
