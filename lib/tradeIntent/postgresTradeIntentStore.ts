import type { RiskDecision } from "@/lib/risk/types";
import type { PgQueryable } from "@/lib/execution/storeTypes";
import type { TradeIntent, TradeIntentListFilter, TradeIntentStatus } from "./types";
import type { TradeIntentStore } from "./tradeIntentStore";

interface TradeIntentRow {
  id: string | number;
  public_id: string;
  symbol: string;
  exchange: string;
  timeframe: string | null;
  ts: Date | string;
  source_signal_refs: string[] | null;
  strategy_id: string | null;
  strategy_version: string | null;
  feature_version: string | null;
  direction: string;
  status: string;
  entry_logic: string | null;
  entry_price: string | number | null;
  stop_loss: string | number | null;
  take_profit: string | number | null;
  suggested_size: string | number | null;
  max_risk_usd: string | number | null;
  risk_decision: RiskDecision | null;
  risk_version: string;
  metadata: Record<string, unknown> | null;
  inserted_at: Date | string;
  created_at: Date | string | null;
  expires_at: Date | string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function numberOrNull(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function requireText(label: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`${label} is required for persistence`);
}

export function validateTradeIntentForPersistence(intent: TradeIntent): void {
  requireText("trade intent symbol", intent.symbol);
  requireText("trade intent exchange", intent.exchange);
  requireText("trade intent timeframe", intent.timeframe);
  requireText("trade intent strategyId", intent.strategyId);
  requireText("trade intent strategyVersion", intent.strategyVersion);
  requireText("trade intent featureVersion", intent.featureVersion);
  requireText("trade intent riskVersion", intent.riskDecision.riskVersion);
  if (!Number.isFinite(Date.parse(intent.ts))) throw new Error("trade intent ts must be valid");
  if (intent.createdAt && !Number.isFinite(Date.parse(intent.createdAt))) {
    throw new Error("trade intent createdAt must be valid");
  }
  if (intent.expiresAt && !Number.isFinite(Date.parse(intent.expiresAt))) {
    throw new Error("trade intent expiresAt must be valid");
  }
  if (!Number.isFinite(intent.entryPrice) || intent.entryPrice <= 0) {
    throw new Error("trade intent entryPrice must be positive");
  }
  if (!Number.isFinite(intent.suggestedSize) || intent.suggestedSize < 0) {
    throw new Error("trade intent suggestedSize must be non-negative");
  }
  if (!Number.isFinite(intent.maxRiskUsd) || intent.maxRiskUsd < 0) {
    throw new Error("trade intent maxRiskUsd must be non-negative");
  }
}

export function rowToTradeIntent(row: TradeIntentRow): TradeIntent {
  if (!row.timeframe || !row.strategy_id || !row.strategy_version || !row.feature_version) {
    throw new Error(`trade intent ${row.public_id} is missing P7 persistence lineage`);
  }
  if (!row.risk_decision) throw new Error(`trade intent ${row.public_id} is missing risk decision`);
  if (row.risk_decision.riskVersion !== row.risk_version) {
    throw new Error(`trade intent ${row.public_id} has inconsistent risk version lineage`);
  }
  const entryPrice = numberOrNull(row.entry_price);
  if (entryPrice === null) throw new Error(`trade intent ${row.public_id} is missing entry price`);
  return {
    id: row.public_id,
    symbol: row.symbol,
    exchange: row.exchange,
    timeframe: row.timeframe,
    ts: iso(row.ts),
    sourceSignalIds: [...(row.source_signal_refs ?? [])],
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    featureVersion: row.feature_version,
    direction: row.direction.toUpperCase() as TradeIntent["direction"],
    status: row.status as TradeIntentStatus,
    entryLogic: row.entry_logic ?? "",
    entryPrice,
    stopLoss: numberOrNull(row.stop_loss),
    takeProfit: numberOrNull(row.take_profit),
    suggestedSize: Number(row.suggested_size ?? 0),
    maxRiskUsd: Number(row.max_risk_usd ?? 0),
    riskDecision: structuredClone(row.risk_decision),
    metadata: structuredClone(row.metadata ?? {}),
    createdAt: iso(row.created_at ?? row.inserted_at),
    expiresAt: row.expires_at === null ? null : iso(row.expires_at),
  };
}

export class PostgresTradeIntentStore implements TradeIntentStore {
  constructor(private readonly db: PgQueryable) {}

  async insertIntent(intent: TradeIntent): Promise<TradeIntent> {
    validateTradeIntentForPersistence(intent);
    const publicId = intent.id ?? null;
    if (publicId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(publicId)) {
      throw new Error("persisted trade intent id must be a UUID when supplied");
    }
    const legacySignalIds = intent.sourceSignalIds.every((id) => /^\d+$/.test(id))
      ? intent.sourceSignalIds
      : [];
    const { rows } = await this.db.query<TradeIntentRow>(
      `insert into trade_intents (
         public_id, symbol, exchange, timeframe, ts,
         source_signal_ids, source_signal_refs,
         strategy_id, strategy_version, feature_version,
         direction, status, entry_logic, entry_price,
         stop_loss, take_profit, suggested_size, max_risk_usd,
         risk_decision, risk_version, metadata, created_at, expires_at)
       values (
         coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5,
         $6::bigint[], $7::text[],
         $8, $9, $10,
         $11, $12, $13, $14,
         $15, $16, $17, $18,
         $19::jsonb, $20, $21::jsonb, $22, $23)
       returning *`,
      [
        publicId, intent.symbol, intent.exchange, intent.timeframe, intent.ts,
        legacySignalIds, intent.sourceSignalIds,
        intent.strategyId, intent.strategyVersion, intent.featureVersion,
        intent.direction.toLowerCase(), intent.status, intent.entryLogic, intent.entryPrice,
        intent.stopLoss, intent.takeProfit, intent.suggestedSize, intent.maxRiskUsd,
        JSON.stringify(intent.riskDecision), intent.riskDecision.riskVersion,
        JSON.stringify(intent.metadata), intent.createdAt ?? intent.ts, intent.expiresAt ?? null,
      ],
    );
    return rowToTradeIntent(rows[0]);
  }

  async fetchIntent(id: string): Promise<TradeIntent | null> {
    const { rows } = await this.db.query<TradeIntentRow>(
      `select * from trade_intents
       where public_id::text = $1 or id::text = $1
       limit 1`,
      [id],
    );
    return rows[0] ? rowToTradeIntent(rows[0]) : null;
  }

  async listIntents(filter: TradeIntentListFilter = {}): Promise<TradeIntent[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      clauses.push(sql.replace("?", `$${values.length}`));
    };
    if (filter.symbol !== undefined) add("symbol = ?", filter.symbol);
    if (filter.exchange !== undefined) add("exchange = ?", filter.exchange);
    if (filter.timeframe !== undefined) add("timeframe = ?", filter.timeframe);
    if (filter.strategyId !== undefined) add("strategy_id = ?", filter.strategyId);
    if (filter.direction !== undefined) add("direction = ?", filter.direction.toLowerCase());
    if (filter.status !== undefined) {
      add("status = any(?::text[])", Array.isArray(filter.status) ? filter.status : [filter.status]);
    }
    if (filter.fromTs !== undefined) add("ts >= ?", filter.fromTs);
    if (filter.toTs !== undefined) add("ts < ?", filter.toTs);
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const { rows } = await this.db.query<TradeIntentRow>(
      `select * from trade_intents ${where} order by coalesce(created_at, inserted_at) asc, id asc`,
      values,
    );
    return rows.map(rowToTradeIntent);
  }
}
