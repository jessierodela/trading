import {
  PostgresPaperTradingStore,
  createPaperOrder,
  openPaperPosition,
  simulatePaperFill,
  updatePaperPositionWithBar,
  validatePaperOrderForPersistence,
  validatePaperPositionForPersistence,
  type PaperFill,
  type PaperOrder,
  type PaperPosition,
  type PgQueryable,
} from "@/lib/execution";
import { createTradeIntent, PostgresTradeIntentStore, type TradeIntent } from "@/lib/tradeIntent";
import type { StrategySignal } from "@/lib/quant/types";
import type { RiskDecision } from "@/lib/risk/types";
import { RISK_VERSION } from "@/lib/versions";
import { Pool, type QueryResult, type QueryResultRow } from "pg";

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

async function rejects(name: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  let rejected = false;
  try {
    await fn();
  } catch {
    rejected = true;
  }
  assert(name, rejected);
}

function signal(): StrategySignal {
  return {
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
    ts: "2026-06-12T12:00:00.000Z",
    strategyId: "momentum_continuation",
    signalType: "trigger",
    direction: "long",
    confidence: 0.82,
    invalidationPrice: 98,
    stopLoss: 98,
    takeProfit: 104,
    features: {
      symbol: "BTC-USD",
      exchange: "COINBASE",
      timeframe: "1h",
      ts: "2026-06-12T12:00:00.000Z",
      close: 100,
      featureVersion: "features.persistence.v1",
    },
    reasons: ["persistence smoke"],
    strategyVersion: "strategy.persistence.v1",
    featureVersion: "features.persistence.v1",
  };
}

function riskDecision(): RiskDecision {
  return {
    approved: true,
    reason: "Risk approved for paper persistence smoke",
    sizeMultiplier: 0.5,
    maxRiskUsd: 100,
    positionSize: 2,
    stopLoss: 98,
    takeProfit: 104,
    blockedBy: [],
    warnings: ["PAPER_ONLY"],
    riskVersion: RISK_VERSION,
  };
}

function intent(): TradeIntent {
  return createTradeIntent({
    signal: signal(),
    riskDecision: riskDecision(),
    entryPrice: 100,
    entryLogic: "Enter at the explicitly supplied paper price",
    sourceSignalIds: ["signal-alpha", "signal-beta"],
    metadata: { paperOnly: true, regime: "TREND_UP", nested: { source: "smoke" } },
    nowTs: "2026-06-12T12:01:00.000Z",
    expiresAt: "2026-06-12T13:00:00.000Z",
  });
}

function intentRow(value: TradeIntent, id: string) {
  return {
    id: 1,
    public_id: id,
    symbol: value.symbol,
    exchange: value.exchange,
    timeframe: value.timeframe,
    ts: new Date(value.ts),
    source_signal_refs: value.sourceSignalIds,
    strategy_id: value.strategyId,
    strategy_version: value.strategyVersion,
    feature_version: value.featureVersion,
    direction: value.direction.toLowerCase(),
    status: value.status,
    entry_logic: value.entryLogic,
    entry_price: String(value.entryPrice),
    stop_loss: value.stopLoss === null ? null : String(value.stopLoss),
    take_profit: value.takeProfit === null ? null : String(value.takeProfit),
    suggested_size: String(value.suggestedSize),
    max_risk_usd: String(value.maxRiskUsd),
    risk_decision: structuredClone(value.riskDecision),
    risk_version: value.riskDecision.riskVersion,
    metadata: structuredClone(value.metadata),
    inserted_at: new Date(value.createdAt ?? value.ts),
    created_at: new Date(value.createdAt ?? value.ts),
    expires_at: value.expiresAt ? new Date(value.expiresAt) : null,
  };
}

function orderRow(value: PaperOrder, id: string) {
  return {
    public_id: id,
    trade_intent_public_id: value.tradeIntentId,
    symbol: value.symbol,
    exchange: value.exchange,
    timeframe: value.timeframe,
    side: value.side.toLowerCase(),
    order_type: value.orderType,
    quantity: String(value.quantity),
    requested_price: String(value.requestedPrice),
    status: value.status,
    reason: value.reason,
    created_at: new Date(value.createdAt),
    filled_at: value.filledAt ? new Date(value.filledAt) : null,
    fill_price: value.fillPrice === null ? null : String(value.fillPrice),
    slippage_bps: String(value.slippageBps),
    fee_bps: String(value.feeBps),
    metadata: structuredClone(value.metadata),
  };
}

function fillRow(value: PaperFill) {
  return {
    order_public_id: value.orderId,
    symbol: value.symbol,
    filled_at: new Date(value.ts),
    quantity: String(value.quantity),
    requested_price: String(value.requestedPrice),
    price: String(value.fillPrice),
    slippage_cost: String(value.slippageCost),
    fee: String(value.fee),
    metadata: { paperOnly: true, slippageCost: value.slippageCost },
  };
}

function positionRow(value: PaperPosition, id: string) {
  return {
    public_id: id,
    trade_intent_public_id: value.tradeIntentId,
    order_public_id: value.orderId,
    symbol: value.symbol,
    exchange: value.exchange,
    timeframe: value.timeframe,
    direction: value.direction.toLowerCase(),
    quantity: String(value.quantity),
    avg_entry: String(value.entryPrice),
    mark_price: String(value.markPrice),
    stop_loss: value.stopLoss === null ? null : String(value.stopLoss),
    take_profit: value.takeProfit === null ? null : String(value.takeProfit),
    opened_at: new Date(value.openedAt),
    closed_at: value.closedAt ? new Date(value.closedAt) : null,
    exit_price: value.exitPrice === null ? null : String(value.exitPrice),
    realized_pnl: value.realizedPnl === null ? null : String(value.realizedPnl),
    unrealized_pnl: String(value.unrealizedPnl),
    fees: String(value.fees),
    status: value.status,
    metadata: structuredClone(value.metadata),
  };
}

class ScriptedDb implements PgQueryable {
  readonly calls: { text: string; values: unknown[] }[] = [];

  constructor(private readonly responses: QueryResultRow[][]) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    this.calls.push({ text, values });
    const rows = (this.responses.shift() ?? []) as Row[];
    return {
      command: "SELECT",
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows,
    };
  }
}

async function runContractSmoke(): Promise<void> {
  console.log("\n=== credential-free persistence contract ===");
  const intentId = "11111111-1111-4111-8111-111111111111";
  const orderId = "22222222-2222-4222-8222-222222222222";
  const positionId = "33333333-3333-4333-8333-333333333333";
  const sourceIntent = intent();
  const persistedIntent = { ...sourceIntent, id: intentId };
  const accepted = { ...createPaperOrder(persistedIntent, {
    slippageBps: 10,
    feeBps: 5,
    nowTs: "2026-06-12T12:02:00.000Z",
  }), id: orderId };
  const fill = simulatePaperFill(accepted, "2026-06-12T12:03:00.000Z");
  const filled: PaperOrder = {
    ...accepted,
    status: "filled",
    reason: "PAPER_ORDER_FILLED",
    filledAt: fill.ts,
    fillPrice: fill.fillPrice,
  };
  const open = { ...openPaperPosition(persistedIntent, filled, fill), id: positionId };
  const closed = updatePaperPositionWithBar(open, {
    symbol: open.symbol,
    exchange: "COINBASE",
    ts: "2026-06-12T13:00:00.000Z",
    open: 101,
    high: 105,
    low: 100,
    close: 104,
  }, { slippageBps: 10, feeBps: 5 });

  const db = new ScriptedDb([
    [intentRow(persistedIntent, intentId)],
    [intentRow(persistedIntent, intentId)],
    [orderRow(accepted, orderId)],
    [orderRow(accepted, orderId)],
    [fillRow(fill)],
    [fillRow(fill)],
    [orderRow(filled, orderId)],
    [positionRow(open, positionId)],
    [positionRow(open, positionId)],
    [positionRow(closed, positionId)],
    [positionRow(open, positionId)],
    [positionRow(closed, positionId)],
    [{ realized_pnl: String(closed.realizedPnl ?? 0) }],
  ]);
  const intentStore = new PostgresTradeIntentStore(db);
  const paperStore = new PostgresPaperTradingStore(db);

  const insertedIntent = await intentStore.insertIntent(sourceIntent);
  const fetchedIntent = await intentStore.fetchIntent(intentId);
  const insertedOrder = await paperStore.insertOrder(accepted);
  const fetchedOrder = await paperStore.fetchOrder(orderId);
  const insertedFill = await paperStore.insertFill(fill);
  const fetchedFill = await paperStore.fetchFill(orderId);
  await paperStore.updateOrder(filled);
  const insertedPosition = await paperStore.insertPosition(open);
  const fetchedPosition = await paperStore.fetchPosition(positionId);
  const updatedPosition = await paperStore.updatePosition(closed);
  const openPositions = await paperStore.listPositions({ status: "open" });
  const closedPositions = await paperStore.listPositions({ status: "closed" });
  const realizedPnl = await paperStore.aggregateRealizedPnl();

  assert("can persist and fetch trade intent", insertedIntent.id === intentId && fetchedIntent?.id === intentId);
  assert("preserves riskDecision JSON", fetchedIntent?.riskDecision.reason === sourceIntent.riskDecision.reason, fetchedIntent);
  assert("preserves riskVersion", fetchedIntent?.riskDecision.riskVersion === RISK_VERSION, fetchedIntent);
  assert("preserves sourceSignalIds", fetchedIntent?.sourceSignalIds.join(",") === "signal-alpha,signal-beta", fetchedIntent);
  assert("preserves strategyVersion", fetchedIntent?.strategyVersion === sourceIntent.strategyVersion, fetchedIntent);
  assert("preserves featureVersion", fetchedIntent?.featureVersion === sourceIntent.featureVersion, fetchedIntent);
  assert("preserves metadata", (fetchedIntent?.metadata.nested as { source?: string })?.source === "smoke", fetchedIntent);
  assert("can persist and fetch paper order", insertedOrder.id === orderId && fetchedOrder?.status === "accepted");
  assert("can persist and fetch paper fill", insertedFill.fillPrice === fill.fillPrice && fetchedFill?.fee === fill.fee);
  assert("can persist and fetch open position", insertedPosition.status === "open" && fetchedPosition?.status === "open");
  assert("can update position to closed", updatedPosition.status === "closed" && updatedPosition.realizedPnl === closed.realizedPnl);
  assert("can list open positions", openPositions.length === 1 && openPositions[0].status === "open");
  assert("can list closed positions", closedPositions.length === 1 && closedPositions[0].status === "closed");
  assert("can calculate aggregate realized PnL", realizedPnl === closed.realizedPnl, realizedPnl);

  const intentInsertParams = db.calls[0].values;
  assert("writes string signal lineage without bigint coercion", JSON.stringify(intentInsertParams[6]) === JSON.stringify(sourceIntent.sourceSignalIds), intentInsertParams[6]);
  assert("writes risk version as an explicit column", intentInsertParams[19] === RISK_VERSION, intentInsertParams[19]);
  assert("writes paper order with no external broker id", db.calls[2].text.includes("external_order_id") && !db.calls[2].values.includes("live"));

  await rejects("rejects order without paper-only metadata", () => validatePaperOrderForPersistence({
    ...accepted,
    metadata: {},
  }));
  await rejects("rejects invalid closed position state", () => validatePaperPositionForPersistence({
    ...open,
    status: "closed",
  }));
  const forbidden = ["externalOrderId", "brokerOrderId", "accountId", "liveExecution"];
  assert("does not create live broker or exchange fields", forbidden.every((key) => !(key in insertedOrder)), Object.keys(insertedOrder));
}

async function runLivePostgresSmoke(dbUrl: string): Promise<void> {
  console.log("\n=== live Postgres persistence transaction ===");
  const pool = new Pool({ connectionString: dbUrl });
  const client = await pool.connect();
  try {
    const migration = await client.query<{ ready: boolean }>(`
      select count(*) = 4 as ready
      from information_schema.columns
      where table_schema = 'public'
        and (
          (table_name = 'trade_intents' and column_name = 'source_signal_refs') or
          (table_name = 'orders' and column_name = 'requested_price') or
          (table_name = 'fills' and column_name = 'slippage_cost') or
          (table_name = 'positions' and column_name = 'mark_price')
        )
    `);
    if (!migration.rows[0]?.ready) {
      throw new Error("P7B migration is not applied; run npm.cmd run migrate before the live persistence smoke");
    }

    await client.query("begin");
    const intentStore = new PostgresTradeIntentStore(client);
    const paperStore = new PostgresPaperTradingStore(client);
    const baselinePnl = await paperStore.aggregateRealizedPnl();
    const persistedIntent = await intentStore.insertIntent(intent());
    const accepted = await paperStore.insertOrder(createPaperOrder(persistedIntent, {
      slippageBps: 10,
      feeBps: 5,
      nowTs: "2026-06-12T12:02:00.000Z",
    }));
    const fill = await paperStore.insertFill(simulatePaperFill(accepted, "2026-06-12T12:03:00.000Z"));
    const filled = await paperStore.updateOrder({
      ...accepted,
      status: "filled",
      reason: "PAPER_ORDER_FILLED",
      filledAt: fill.ts,
      fillPrice: fill.fillPrice,
    });
    const open = await paperStore.insertPosition(openPaperPosition(persistedIntent, filled, fill));
    const closed = await paperStore.updatePosition(updatePaperPositionWithBar(open, {
      symbol: open.symbol,
      exchange: "COINBASE",
      ts: "2026-06-12T13:00:00.000Z",
      open: 101,
      high: 105,
      low: 100,
      close: 104,
    }, { slippageBps: 10, feeBps: 5 }));

    const reloadedIntentStore = new PostgresTradeIntentStore(client);
    const reloadedPaperStore = new PostgresPaperTradingStore(client);
    const fetchedIntent = await reloadedIntentStore.fetchIntent(persistedIntent.id!);
    const fetchedOrder = await reloadedPaperStore.fetchOrder(accepted.id!);
    const fetchedFill = await reloadedPaperStore.fetchFill(accepted.id!);
    const fetchedPosition = await reloadedPaperStore.fetchPosition(open.id!);
    const realizedPnl = await reloadedPaperStore.aggregateRealizedPnl();

    assert("Postgres reloads persisted trade intent", fetchedIntent?.sourceSignalIds.length === 2, fetchedIntent);
    assert("Postgres reloads persisted paper order", fetchedOrder?.status === "filled", fetchedOrder);
    assert("Postgres reloads persisted paper fill", fetchedFill?.fillPrice === fill.fillPrice, fetchedFill);
    assert("Postgres reloads persisted closed position", fetchedPosition?.status === "closed", fetchedPosition);
    assert("Postgres aggregate includes closed paper PnL", Math.abs((realizedPnl - baselinePnl) - (closed.realizedPnl ?? 0)) < 1e-9, {
      baselinePnl,
      realizedPnl,
      closedPnl: closed.realizedPnl,
    });
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

async function main(): Promise<void> {
  await runContractSmoke();
  const dbUrl = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  if (dbUrl) {
    await runLivePostgresSmoke(dbUrl);
  } else {
    console.log("\nSKIP: live Postgres persistence smoke (set SUPABASE_DB_URL or DATABASE_URL to enable)");
  }
  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`} (${passed} passed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
