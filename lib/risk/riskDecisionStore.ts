/**
 * lib/risk/riskDecisionStore.ts
 *
 * P11: durable persistence for every risk-engine decision made on the
 * scheduled strategy signal path — approved AND rejected. Mirrors the
 * lib/tradeIntent store conventions: a plain interface, a Postgres-backed
 * implementation, and an in-memory implementation for tests.
 */
import type { Pool } from "pg";
import type { RiskDecision } from "./types";

export interface PersistedRiskDecision {
  /** public_id (uuid) once persisted. */
  id?: string;
  signalId: number;
  symbol: string;
  exchange: string;
  timeframe: string;
  signalTs: string;
  strategyId: string;
  decision: RiskDecision;
  tradeIntentId: string | null;
  evaluatedAt: string;
  createdAt?: string;
}

export interface RiskDecisionListFilter {
  symbol?: string;
  approved?: boolean;
  fromTs?: string;
  toTs?: string;
  limit?: number;
}

export interface RiskDecisionStore {
  /**
   * Idempotent by (signalId, decision.riskVersion): a rerun for the same
   * closed bar returns the originally persisted row instead of creating a
   * duplicate.
   */
  insertDecision(decision: PersistedRiskDecision): Promise<PersistedRiskDecision>;
  findBySignalAndVersion(signalId: number, riskVersion: string): Promise<PersistedRiskDecision | null>;
  listDecisions(filter?: RiskDecisionListFilter): Promise<PersistedRiskDecision[]>;

  /**
   * Back-links an approved decision to the trade intent it produced, for
   * audit traceability. Only ever sets a previously-null trade_intent_id —
   * a decision's link is write-once, so a rerun can never overwrite an
   * already-linked intent with a different one.
   */
  linkTradeIntent(signalId: number, riskVersion: string, tradeIntentId: string): Promise<void>;
}

interface RiskDecisionRow {
  public_id: string;
  signal_id: string | number;
  symbol: string;
  exchange: string;
  timeframe: string;
  signal_ts: Date | string;
  strategy_id: string;
  approved: boolean;
  reason: string;
  blocked_by: string[] | null;
  warnings: string[] | null;
  size_multiplier: string | number;
  max_risk_usd: string | number;
  position_size: string | number;
  stop_loss: string | number | null;
  take_profit: string | number | null;
  risk_version: string;
  trade_intent_id: string | null;
  evaluated_at: Date | string;
  inserted_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function num(value: string | number): number {
  return Number(value);
}

function rowToDecision(row: RiskDecisionRow): PersistedRiskDecision {
  return {
    id: row.public_id,
    signalId: Number(row.signal_id),
    symbol: row.symbol,
    exchange: row.exchange,
    timeframe: row.timeframe,
    signalTs: iso(row.signal_ts),
    strategyId: row.strategy_id,
    decision: {
      approved: row.approved,
      reason: row.reason,
      sizeMultiplier: num(row.size_multiplier),
      maxRiskUsd: num(row.max_risk_usd),
      positionSize: num(row.position_size),
      stopLoss: row.stop_loss === null ? null : num(row.stop_loss),
      takeProfit: row.take_profit === null ? null : num(row.take_profit),
      blockedBy: [...(row.blocked_by ?? [])],
      warnings: [...(row.warnings ?? [])],
      riskVersion: row.risk_version,
    },
    tradeIntentId: row.trade_intent_id,
    evaluatedAt: iso(row.evaluated_at),
    createdAt: iso(row.inserted_at),
  };
}

export class PostgresRiskDecisionStore implements RiskDecisionStore {
  constructor(private readonly pool: Pool) {}

  async insertDecision(decision: PersistedRiskDecision): Promise<PersistedRiskDecision> {
    const { rows } = await this.pool.query<RiskDecisionRow>(
      `insert into risk_decisions (
         signal_id, symbol, exchange, timeframe, signal_ts, strategy_id,
         approved, reason, blocked_by, warnings, size_multiplier, max_risk_usd,
         position_size, stop_loss, take_profit, risk_version, trade_intent_id, evaluated_at)
       values ($1,$2,$3,$4,$5,$6, $7,$8,$9,$10,$11,$12, $13,$14,$15,$16,$17,$18)
       on conflict (signal_id, risk_version)
       do update set evaluated_at = risk_decisions.evaluated_at
       returning *`,
      [
        decision.signalId, decision.symbol, decision.exchange, decision.timeframe,
        decision.signalTs, decision.strategyId,
        decision.decision.approved, decision.decision.reason,
        decision.decision.blockedBy, decision.decision.warnings,
        decision.decision.sizeMultiplier, decision.decision.maxRiskUsd,
        decision.decision.positionSize, decision.decision.stopLoss, decision.decision.takeProfit,
        decision.decision.riskVersion, decision.tradeIntentId, decision.evaluatedAt,
      ],
    );
    return rowToDecision(rows[0]);
  }

  async findBySignalAndVersion(signalId: number, riskVersion: string): Promise<PersistedRiskDecision | null> {
    const { rows } = await this.pool.query<RiskDecisionRow>(
      `select * from risk_decisions where signal_id = $1 and risk_version = $2 limit 1`,
      [signalId, riskVersion],
    );
    return rows[0] ? rowToDecision(rows[0]) : null;
  }

  async linkTradeIntent(signalId: number, riskVersion: string, tradeIntentId: string): Promise<void> {
    await this.pool.query(
      `update risk_decisions
       set trade_intent_id = $3
       where signal_id = $1 and risk_version = $2 and trade_intent_id is null`,
      [signalId, riskVersion, tradeIntentId],
    );
  }

  async listDecisions(filter: RiskDecisionListFilter = {}): Promise<PersistedRiskDecision[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      clauses.push(sql.replace("?", `$${values.length}`));
    };
    if (filter.symbol !== undefined) add("symbol = ?", filter.symbol);
    if (filter.approved !== undefined) add("approved = ?", filter.approved);
    if (filter.fromTs !== undefined) add("evaluated_at >= ?", filter.fromTs);
    if (filter.toTs !== undefined) add("evaluated_at < ?", filter.toTs);
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 500) : 200;
    const { rows } = await this.pool.query<RiskDecisionRow>(
      `select * from risk_decisions ${where} order by evaluated_at desc, id desc limit ${limit}`,
      values,
    );
    return rows.map(rowToDecision);
  }
}

export class InMemoryRiskDecisionStore implements RiskDecisionStore {
  private rows: PersistedRiskDecision[] = [];
  private nextId = 1;

  async insertDecision(decision: PersistedRiskDecision): Promise<PersistedRiskDecision> {
    const existing = this.rows.find((row) =>
      row.signalId === decision.signalId && row.decision.riskVersion === decision.decision.riskVersion);
    if (existing) return structuredClone(existing);
    const stored: PersistedRiskDecision = structuredClone({
      ...decision,
      id: decision.id ?? `risk-decision-${this.nextId++}`,
      createdAt: decision.createdAt ?? decision.evaluatedAt,
    });
    this.rows.push(stored);
    return structuredClone(stored);
  }

  async findBySignalAndVersion(signalId: number, riskVersion: string): Promise<PersistedRiskDecision | null> {
    const found = this.rows.find((row) => row.signalId === signalId && row.decision.riskVersion === riskVersion);
    return found ? structuredClone(found) : null;
  }

  async linkTradeIntent(signalId: number, riskVersion: string, tradeIntentId: string): Promise<void> {
    const row = this.rows.find((r) => r.signalId === signalId && r.decision.riskVersion === riskVersion);
    if (row && row.tradeIntentId === null) row.tradeIntentId = tradeIntentId;
  }

  async listDecisions(filter: RiskDecisionListFilter = {}): Promise<PersistedRiskDecision[]> {
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 200;
    return this.rows
      .filter((row) =>
        (filter.symbol === undefined || row.symbol === filter.symbol) &&
        (filter.approved === undefined || row.decision.approved === filter.approved) &&
        (filter.fromTs === undefined || row.evaluatedAt >= filter.fromTs) &&
        (filter.toTs === undefined || row.evaluatedAt < filter.toTs))
      .sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))
      .slice(0, limit)
      .map((row) => structuredClone(row));
  }
}
