import type {
  PaperFill,
  PaperOrder,
  PaperOrderListFilter,
  PaperOrderStatus,
  PaperPosition,
  PaperPositionListFilter,
  PaperPositionStatus,
} from "./types";
import type { PaperTradingStore, PgQueryable } from "./storeTypes";

interface PaperOrderRow {
  public_id: string;
  trade_intent_public_id: string;
  symbol: string;
  exchange: string;
  timeframe: string | null;
  side: string;
  order_type: string;
  quantity: string | number;
  requested_price: string | number | null;
  status: string;
  reason: string | null;
  created_at: Date | string;
  filled_at: Date | string | null;
  fill_price: string | number | null;
  slippage_bps: string | number;
  fee_bps: string | number;
  metadata: Record<string, unknown> | null;
}

interface PaperFillRow {
  order_public_id: string;
  symbol: string;
  filled_at: Date | string;
  quantity: string | number;
  requested_price: string | number | null;
  price: string | number;
  slippage_cost: string | number;
  fee: string | number | null;
  metadata: Record<string, unknown> | null;
}

interface PaperPositionRow {
  public_id: string;
  trade_intent_public_id: string;
  order_public_id: string;
  symbol: string;
  exchange: string;
  timeframe: string | null;
  direction: string;
  quantity: string | number;
  avg_entry: string | number;
  mark_price: string | number | null;
  stop_loss: string | number | null;
  take_profit: string | number | null;
  opened_at: Date | string;
  closed_at: Date | string | null;
  exit_price: string | number | null;
  realized_pnl: string | number | null;
  unrealized_pnl: string | number;
  fees: string | number;
  status: string;
  metadata: Record<string, unknown> | null;
}

const ORDER_SELECT = `
  select o.*, ti.public_id::text as trade_intent_public_id
  from orders o
  join trade_intents ti on ti.id = o.trade_intent_id`;

const POSITION_SELECT = `
  select p.*,
         ti.public_id::text as trade_intent_public_id,
         o.public_id::text as order_public_id
  from positions p
  join trade_intents ti on ti.id = p.trade_intent_id
  join orders o on o.id = p.order_id`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function numberOrNull(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function requirePaperMetadata(label: string, metadata: Record<string, unknown>): void {
  if (metadata.paperOnly !== true) throw new Error(`${label} metadata.paperOnly must be true`);
}

function requirePaperLineageMetadata(label: string, metadata: Record<string, unknown>): void {
  requirePaperMetadata(label, metadata);
  const requiredStrings = ["riskVersion", "strategyId", "strategyVersion", "featureVersion"];
  for (const key of requiredStrings) {
    if (typeof metadata[key] !== "string" || String(metadata[key]).trim().length === 0) {
      throw new Error(`${label} metadata.${key} is required`);
    }
  }
  if (!Array.isArray(metadata.sourceSignalIds)) {
    throw new Error(`${label} metadata.sourceSignalIds is required`);
  }
  if (typeof metadata.riskDecision !== "object" || metadata.riskDecision === null) {
    throw new Error(`${label} metadata.riskDecision is required`);
  }
}

function validateFinite(label: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${label} must be at least ${minimum}`);
}

export function validatePaperOrderForPersistence(order: PaperOrder): void {
  requirePaperLineageMetadata("paper order", order.metadata);
  if (order.tradeIntentId.trim().length === 0) throw new Error("paper order tradeIntentId is required");
  if (order.symbol.trim().length === 0 || order.exchange.trim().length === 0 || order.timeframe.trim().length === 0) {
    throw new Error("paper order instrument fields are required");
  }
  if (order.reason.trim().length === 0) throw new Error("paper order reason is required");
  if (!Number.isFinite(Date.parse(order.createdAt))) throw new Error("paper order createdAt must be valid");
  validateFinite("paper order quantity", order.quantity, order.status === "rejected" ? 0 : Number.MIN_VALUE);
  validateFinite("paper order requestedPrice", order.requestedPrice, Number.MIN_VALUE);
  validateFinite("paper order slippageBps", order.slippageBps, 0);
  validateFinite("paper order feeBps", order.feeBps, 0);
  if (order.status === "filled" && (order.fillPrice === null || order.filledAt === null)) {
    throw new Error("filled paper order requires fillPrice and filledAt");
  }
  if (order.status !== "filled" && (order.fillPrice !== null || order.filledAt !== null)) {
    throw new Error("unfilled paper order cannot contain fill state");
  }
  if (order.status === "rejected" && order.quantity !== 0) {
    throw new Error("rejected paper order quantity must be zero");
  }
  if (order.filledAt !== null && !Number.isFinite(Date.parse(order.filledAt))) {
    throw new Error("paper order filledAt must be valid");
  }
  if (order.fillPrice !== null) validateFinite("paper order fillPrice", order.fillPrice, Number.MIN_VALUE);
}

export function validatePaperFillForPersistence(fill: PaperFill): void {
  if (fill.orderId.trim().length === 0) throw new Error("paper fill orderId is required");
  if (fill.symbol.trim().length === 0) throw new Error("paper fill symbol is required");
  if (!Number.isFinite(Date.parse(fill.ts))) throw new Error("paper fill ts must be valid");
  validateFinite("paper fill quantity", fill.quantity, Number.MIN_VALUE);
  validateFinite("paper fill requestedPrice", fill.requestedPrice, Number.MIN_VALUE);
  validateFinite("paper fill fillPrice", fill.fillPrice, Number.MIN_VALUE);
  validateFinite("paper fill slippageCost", fill.slippageCost, 0);
  validateFinite("paper fill fee", fill.fee, 0);
}

export function validatePaperPositionForPersistence(position: PaperPosition): void {
  requirePaperLineageMetadata("paper position", position.metadata);
  if (position.tradeIntentId.trim().length === 0 || position.orderId.trim().length === 0) {
    throw new Error("paper position tradeIntentId and orderId are required");
  }
  if (position.timeframe.trim().length === 0) throw new Error("paper position timeframe is required");
  if (position.symbol.trim().length === 0 || position.exchange.trim().length === 0) {
    throw new Error("paper position instrument fields are required");
  }
  if (!Number.isFinite(Date.parse(position.openedAt))) throw new Error("paper position openedAt must be valid");
  validateFinite("paper position quantity", position.quantity, Number.MIN_VALUE);
  validateFinite("paper position entryPrice", position.entryPrice, Number.MIN_VALUE);
  validateFinite("paper position markPrice", position.markPrice, Number.MIN_VALUE);
  validateFinite("paper position fees", position.fees, 0);
  if (!Number.isFinite(position.unrealizedPnl)) throw new Error("paper position unrealizedPnl must be finite");
  if (position.stopLoss !== null) validateFinite("paper position stopLoss", position.stopLoss, Number.MIN_VALUE);
  if (position.takeProfit !== null) validateFinite("paper position takeProfit", position.takeProfit, Number.MIN_VALUE);
  if (position.status === "closed" && (position.closedAt === null || position.exitPrice === null || position.realizedPnl === null)) {
    throw new Error("closed paper position requires closedAt, exitPrice, and realizedPnl");
  }
  if (position.closedAt !== null && !Number.isFinite(Date.parse(position.closedAt))) {
    throw new Error("paper position closedAt must be valid");
  }
  if (position.exitPrice !== null) validateFinite("paper position exitPrice", position.exitPrice, Number.MIN_VALUE);
  if (position.realizedPnl !== null && !Number.isFinite(position.realizedPnl)) {
    throw new Error("paper position realizedPnl must be finite");
  }
  if (position.status === "closed" && position.unrealizedPnl !== 0) {
    throw new Error("closed paper position unrealizedPnl must be zero");
  }
  if (position.status === "open" && (position.closedAt !== null || position.exitPrice !== null || position.realizedPnl !== null)) {
    throw new Error("open paper position cannot contain closed state");
  }
}

export function rowToPaperOrder(row: PaperOrderRow): PaperOrder {
  if (!row.timeframe || row.requested_price === null) {
    throw new Error(`paper order ${row.public_id} is missing P7 persistence fields`);
  }
  const order: PaperOrder = {
    id: row.public_id,
    tradeIntentId: row.trade_intent_public_id,
    symbol: row.symbol,
    exchange: row.exchange,
    timeframe: row.timeframe,
    side: row.side.toUpperCase() as PaperOrder["side"],
    orderType: row.order_type as PaperOrder["orderType"],
    quantity: Number(row.quantity),
    requestedPrice: Number(row.requested_price),
    status: row.status as PaperOrderStatus,
    reason: row.reason ?? "",
    createdAt: iso(row.created_at),
    filledAt: row.filled_at === null ? null : iso(row.filled_at),
    fillPrice: numberOrNull(row.fill_price),
    slippageBps: Number(row.slippage_bps),
    feeBps: Number(row.fee_bps),
    metadata: structuredClone(row.metadata ?? {}),
  };
  requirePaperLineageMetadata("paper order", order.metadata);
  return order;
}

export function rowToPaperFill(row: PaperFillRow): PaperFill {
  if (row.requested_price === null) throw new Error(`paper fill for ${row.order_public_id} is missing requested price`);
  requirePaperMetadata("paper fill", row.metadata ?? {});
  return {
    orderId: row.order_public_id,
    symbol: row.symbol,
    ts: iso(row.filled_at),
    quantity: Number(row.quantity),
    requestedPrice: Number(row.requested_price),
    fillPrice: Number(row.price),
    slippageCost: Number(row.slippage_cost),
    fee: Number(row.fee ?? 0),
  };
}

export function rowToPaperPosition(row: PaperPositionRow): PaperPosition {
  if (row.mark_price === null) throw new Error(`paper position ${row.public_id} is missing mark price`);
  if (!row.timeframe) throw new Error(`paper position ${row.public_id} is missing timeframe`);
  const position: PaperPosition = {
    id: row.public_id,
    tradeIntentId: row.trade_intent_public_id,
    orderId: row.order_public_id,
    symbol: row.symbol,
    exchange: row.exchange,
    timeframe: row.timeframe,
    direction: row.direction.toUpperCase() as PaperPosition["direction"],
    quantity: Number(row.quantity),
    entryPrice: Number(row.avg_entry),
    markPrice: Number(row.mark_price),
    stopLoss: numberOrNull(row.stop_loss),
    takeProfit: numberOrNull(row.take_profit),
    openedAt: iso(row.opened_at),
    closedAt: row.closed_at === null ? null : iso(row.closed_at),
    exitPrice: numberOrNull(row.exit_price),
    realizedPnl: numberOrNull(row.realized_pnl),
    unrealizedPnl: Number(row.unrealized_pnl),
    fees: Number(row.fees),
    status: row.status as PaperPositionStatus,
    metadata: structuredClone(row.metadata ?? {}),
  };
  requirePaperLineageMetadata("paper position", position.metadata);
  return position;
}

export class PostgresPaperTradingStore implements PaperTradingStore {
  constructor(private readonly db: PgQueryable) {}

  async insertOrder(order: PaperOrder): Promise<PaperOrder> {
    validatePaperOrderForPersistence(order);
    const publicId = order.id ?? null;
    if (publicId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(publicId)) {
      throw new Error("persisted paper order id must be a UUID when supplied");
    }
    const { rows } = await this.db.query<PaperOrderRow>(
      `with inserted as (
         insert into orders (
           public_id, trade_intent_id, symbol, exchange, timeframe,
           side, order_type, quantity, limit_price, requested_price,
           status, reason, submitted_at, created_at, filled_at, fill_price,
           slippage_bps, fee_bps, metadata, external_order_id)
         select coalesce($1::uuid, gen_random_uuid()), ti.id, $3, $4, $5,
                $6, $7, $8, $9, $10,
                $11, $12, null, $13, $14, $15,
                $16, $17, $18::jsonb, null
         from trade_intents ti
         where ti.public_id::text = $2 or ti.id::text = $2
         returning *)
       select i.*, ti.public_id::text as trade_intent_public_id
       from inserted i join trade_intents ti on ti.id = i.trade_intent_id`,
      [
        publicId, order.tradeIntentId, order.symbol, order.exchange, order.timeframe,
        order.side.toLowerCase(), order.orderType, order.quantity,
        order.orderType === "limit" ? order.requestedPrice : null, order.requestedPrice,
        order.status, order.reason, order.createdAt, order.filledAt, order.fillPrice,
        order.slippageBps, order.feeBps, JSON.stringify(order.metadata),
      ],
    );
    if (!rows[0]) throw new Error(`trade intent not found for paper order: ${order.tradeIntentId}`);
    return rowToPaperOrder(rows[0]);
  }

  async updateOrder(order: PaperOrder): Promise<PaperOrder> {
    validatePaperOrderForPersistence(order);
    if (!order.id) throw new Error("paper order id is required for update");
    const { rows } = await this.db.query<PaperOrderRow>(
      `with updated as (
         update orders set
           status = $2, reason = $3, filled_at = $4, fill_price = $5,
           slippage_bps = $6, fee_bps = $7, metadata = $8::jsonb
         where public_id::text = $1
           and external_order_id is null
           and metadata @> '{"paperOnly": true}'::jsonb
           and not (status = 'filled' and $2 <> 'filled')
         returning *)
       select u.*, ti.public_id::text as trade_intent_public_id
       from updated u join trade_intents ti on ti.id = u.trade_intent_id`,
      [
        order.id, order.status, order.reason, order.filledAt, order.fillPrice,
        order.slippageBps, order.feeBps, JSON.stringify(order.metadata),
      ],
    );
    if (!rows[0]) throw new Error(`paper order not found: ${order.id}`);
    return rowToPaperOrder(rows[0]);
  }

  async fetchOrder(id: string): Promise<PaperOrder | null> {
    const { rows } = await this.db.query<PaperOrderRow>(
      `${ORDER_SELECT}
       where (o.public_id::text = $1 or o.id::text = $1)
         and o.external_order_id is null
         and o.metadata @> '{"paperOnly": true}'::jsonb
       limit 1`,
      [id],
    );
    return rows[0] ? rowToPaperOrder(rows[0]) : null;
  }

  async listOrders(filter: PaperOrderListFilter = {}): Promise<PaperOrder[]> {
    const clauses = ["o.external_order_id is null", "o.metadata @> '{\"paperOnly\": true}'::jsonb"];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      clauses.push(sql.replace("?", `$${values.length}`));
    };
    if (filter.tradeIntentId !== undefined) add("ti.public_id::text = ?", filter.tradeIntentId);
    if (filter.symbol !== undefined) add("o.symbol = ?", filter.symbol);
    if (filter.status !== undefined) {
      add("o.status = any(?::text[])", Array.isArray(filter.status) ? filter.status : [filter.status]);
    }
    const { rows } = await this.db.query<PaperOrderRow>(
      `${ORDER_SELECT} where ${clauses.join(" and ")} order by o.created_at asc, o.id asc`,
      values,
    );
    return rows.map(rowToPaperOrder);
  }

  async insertFill(fill: PaperFill): Promise<PaperFill> {
    validatePaperFillForPersistence(fill);
    const metadata = { paperOnly: true, slippageCost: fill.slippageCost };
    const { rows } = await this.db.query<PaperFillRow>(
      `with inserted as (
         insert into fills (
           order_id, symbol, exchange, side, quantity, price, fee, filled_at,
           requested_price, slippage_cost, metadata, raw)
         select o.id, $2, o.exchange, o.side, $3, $4, $5, $6,
                $7, $8, $9::jsonb, $9::jsonb
         from orders o
         where (o.public_id::text = $1 or o.id::text = $1)
           and o.status = 'accepted'
           and o.external_order_id is null
           and o.metadata @> '{"paperOnly": true}'::jsonb
         returning *)
       select i.*, o.public_id::text as order_public_id
       from inserted i join orders o on o.id = i.order_id`,
      [
        fill.orderId, fill.symbol, fill.quantity, fill.fillPrice, fill.fee, fill.ts,
        fill.requestedPrice, fill.slippageCost, JSON.stringify(metadata),
      ],
    );
    if (!rows[0]) throw new Error(`accepted paper order not found for fill: ${fill.orderId}`);
    return rowToPaperFill(rows[0]);
  }

  async fetchFill(orderId: string): Promise<PaperFill | null> {
    const { rows } = await this.db.query<PaperFillRow>(
      `select f.*, o.public_id::text as order_public_id
       from fills f join orders o on o.id = f.order_id
       where (o.public_id::text = $1 or o.id::text = $1)
         and o.external_order_id is null
         and o.metadata @> '{"paperOnly": true}'::jsonb
         and f.metadata @> '{"paperOnly": true}'::jsonb
       order by f.filled_at asc, f.id asc limit 1`,
      [orderId],
    );
    return rows[0] ? rowToPaperFill(rows[0]) : null;
  }

  async listFills(): Promise<PaperFill[]> {
    const { rows } = await this.db.query<PaperFillRow>(
      `select f.*, o.public_id::text as order_public_id
       from fills f join orders o on o.id = f.order_id
       where o.external_order_id is null
         and o.metadata @> '{"paperOnly": true}'::jsonb
         and f.metadata @> '{"paperOnly": true}'::jsonb
       order by f.filled_at asc, f.id asc`,
    );
    return rows.map(rowToPaperFill);
  }

  async insertPosition(position: PaperPosition): Promise<PaperPosition> {
    validatePaperPositionForPersistence(position);
    const publicId = position.id ?? null;
    if (publicId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(publicId)) {
      throw new Error("persisted paper position id must be a UUID when supplied");
    }
    const { rows } = await this.db.query<PaperPositionRow>(
      `with inserted as (
         insert into positions (
           public_id, trade_intent_id, order_id, symbol, exchange, timeframe,
           status, direction, quantity, avg_entry, mark_price,
           stop_loss, take_profit, opened_at, closed_at, exit_price,
           realized_pnl, unrealized_pnl, fees, metadata)
         select coalesce($1::uuid, gen_random_uuid()), ti.id, o.id, $4, $5, $6,
                $7, $8, $9, $10, $11,
                $12, $13, $14, $15, $16,
                $17, $18, $19, $20::jsonb
         from trade_intents ti
         join orders o on o.trade_intent_id = ti.id
         where (ti.public_id::text = $2 or ti.id::text = $2)
           and (o.public_id::text = $3 or o.id::text = $3)
           and o.status = 'filled'
           and o.external_order_id is null
           and o.metadata @> '{"paperOnly": true}'::jsonb
         returning *)
       select i.*,
              ti.public_id::text as trade_intent_public_id,
              o.public_id::text as order_public_id
       from inserted i
       join trade_intents ti on ti.id = i.trade_intent_id
       join orders o on o.id = i.order_id`,
      [
        publicId, position.tradeIntentId, position.orderId, position.symbol, position.exchange,
        position.timeframe, position.status, position.direction.toLowerCase(),
        position.quantity, position.entryPrice, position.markPrice, position.stopLoss,
        position.takeProfit, position.openedAt, position.closedAt, position.exitPrice,
        position.realizedPnl, position.unrealizedPnl, position.fees, JSON.stringify(position.metadata),
      ],
    );
    if (!rows[0]) throw new Error("paper position order/trade-intent lineage not found");
    return rowToPaperPosition(rows[0]);
  }

  async updatePosition(position: PaperPosition): Promise<PaperPosition> {
    validatePaperPositionForPersistence(position);
    if (!position.id) throw new Error("paper position id is required for update");
    const { rows } = await this.db.query<PaperPositionRow>(
      `with updated as (
         update positions set
           status = $2, quantity = $3, avg_entry = $4, mark_price = $5,
           stop_loss = $6, take_profit = $7, closed_at = $8, exit_price = $9,
           realized_pnl = $10, unrealized_pnl = $11, fees = $12, metadata = $13::jsonb
         where public_id::text = $1
           and metadata @> '{"paperOnly": true}'::jsonb
           and order_id in (
             select id from orders
             where external_order_id is null
               and metadata @> '{"paperOnly": true}'::jsonb
           )
           and not (status = 'closed' and $2 = 'open')
         returning *)
       select u.*,
              ti.public_id::text as trade_intent_public_id,
              o.public_id::text as order_public_id
       from updated u
       join trade_intents ti on ti.id = u.trade_intent_id
       join orders o on o.id = u.order_id`,
      [
        position.id, position.status, position.quantity, position.entryPrice, position.markPrice,
        position.stopLoss, position.takeProfit, position.closedAt, position.exitPrice,
        position.realizedPnl, position.unrealizedPnl, position.fees, JSON.stringify(position.metadata),
      ],
    );
    if (!rows[0]) throw new Error(`paper position not found: ${position.id}`);
    return rowToPaperPosition(rows[0]);
  }

  async fetchPosition(id: string): Promise<PaperPosition | null> {
    const { rows } = await this.db.query<PaperPositionRow>(
      `${POSITION_SELECT}
       where (p.public_id::text = $1 or p.id::text = $1)
         and p.metadata @> '{"paperOnly": true}'::jsonb
         and o.external_order_id is null
         and o.metadata @> '{"paperOnly": true}'::jsonb
       limit 1`,
      [id],
    );
    return rows[0] ? rowToPaperPosition(rows[0]) : null;
  }

  async listPositions(filter: PaperPositionListFilter = {}): Promise<PaperPosition[]> {
    const clauses = [
      "p.order_id is not null",
      "p.metadata @> '{\"paperOnly\": true}'::jsonb",
      "o.external_order_id is null",
      "o.metadata @> '{\"paperOnly\": true}'::jsonb",
    ];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      clauses.push(sql.replace("?", `$${values.length}`));
    };
    if (filter.tradeIntentId !== undefined) add("ti.public_id::text = ?", filter.tradeIntentId);
    if (filter.symbol !== undefined) add("p.symbol = ?", filter.symbol);
    if (filter.status !== undefined) {
      add("p.status = any(?::text[])", Array.isArray(filter.status) ? filter.status : [filter.status]);
    }
    const { rows } = await this.db.query<PaperPositionRow>(
      `${POSITION_SELECT} where ${clauses.join(" and ")} order by p.opened_at asc, p.id asc`,
      values,
    );
    return rows.map(rowToPaperPosition);
  }

  async aggregateRealizedPnl(): Promise<number> {
    const { rows } = await this.db.query<{ realized_pnl: string | number }>(
      `select coalesce(sum(p.realized_pnl), 0) as realized_pnl
       from positions p
       join orders o on o.id = p.order_id
       where p.status = 'closed'
         and p.metadata @> '{"paperOnly": true}'::jsonb
         and o.external_order_id is null
         and o.metadata @> '{"paperOnly": true}'::jsonb`,
    );
    return Number(rows[0]?.realized_pnl ?? 0);
  }
}
