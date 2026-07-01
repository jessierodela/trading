/**
 * lib/storage/signalStore.ts
 */
import type { Pool } from "pg";
import type {
  StrategySignal, Exchange, Timeframe, StrategySignalType, Direction,
} from "@/lib/quant/types";
import type { SignalStore, InstrumentFilter, TimeRange } from "./interfaces";

interface SignalRow {
  id:                 number;
  public_id:          string;
  symbol:             string;
  exchange:           string;
  timeframe:          string;
  ts:                 Date;
  strategy_id:        string;
  signal_type:        string;
  direction:          string;
  confidence:         string;
  expected_edge:      string | null;
  invalidation_price: string | null;
  stop_loss:          string | null;
  take_profit:        string | null;
  reasons:            string[] | null;
  features_snapshot:  unknown;
  strategy_version:   string;
  feature_version:    string;
  source_lineage:     unknown;
  inserted_at:        Date;
  deleted_at:         Date | null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rowToSignal(row: SignalRow): StrategySignal & { id: number } {
  return {
    id:                row.id,
    symbol:            row.symbol,
    exchange:          row.exchange as Exchange,
    timeframe:         row.timeframe as Timeframe,
    ts:                row.ts.toISOString(),
    strategyId:        row.strategy_id,
    signalType:        row.signal_type as StrategySignalType,
    direction:         row.direction as Direction,
    confidence:        Number(row.confidence),
    expectedEdge:      row.expected_edge === null ? null : Number(row.expected_edge),
    invalidationPrice: row.invalidation_price === null ? null : Number(row.invalidation_price),
    stopLoss:          row.stop_loss === null ? null : Number(row.stop_loss),
    takeProfit:        row.take_profit === null ? null : Number(row.take_profit),
    reasons:           row.reasons ?? [],
    features:          row.features_snapshot as StrategySignal["features"],
    strategyVersion:   row.strategy_version,
    featureVersion:    row.feature_version,
    sourceLineage:     parseJsonObject(row.source_lineage) as StrategySignal["sourceLineage"],
  };
}

export class PgSignalStore implements SignalStore {
  constructor(private readonly pool: Pool) {}

  async insert(s: StrategySignal): Promise<StrategySignal & { id: number }> {
    const { rows } = await this.pool.query<SignalRow>(
      `insert into strategy_signals (
         symbol, exchange, timeframe, ts,
         strategy_id, signal_type, direction, confidence,
         expected_edge, invalidation_price, stop_loss, take_profit,
         reasons, features_snapshot,
         strategy_version, feature_version, source_lineage)
       values ($1,$2,$3,$4, $5,$6,$7,$8, $9,$10,$11,$12, $13,$14, $15,$16,$17)
       returning *`,
      [
        s.symbol, s.exchange, s.timeframe, s.ts,
        s.strategyId, s.signalType, s.direction, s.confidence,
        s.expectedEdge ?? null, s.invalidationPrice ?? null,
        s.stopLoss ?? null, s.takeProfit ?? null,
        s.reasons, JSON.stringify(s.features),
        s.strategyVersion, s.featureVersion, JSON.stringify(s.sourceLineage ?? {}),
      ],
    );
    return rowToSignal(rows[0]);
  }

  async retract(id: number, _reason?: string): Promise<void> {
    // reason is accepted but not persisted as a column today. Stash in an
    // event log when one exists.
    await this.pool.query(
      `update strategy_signals set deleted_at = now() where id = $1 and deleted_at is null`,
      [id],
    );
  }

  async fetchActiveByStrategy(
    strategyId: string,
    range:      TimeRange,
  ): Promise<(StrategySignal & { id: number })[]> {
    const { rows } = await this.pool.query<SignalRow>(
      `select * from strategy_signals
       where strategy_id = $1 and ts >= $2 and ts < $3 and deleted_at is null
       order by ts asc`,
      [strategyId, range.startTs, range.endTs],
    );
    return rows.map(rowToSignal);
  }

  async fetchRecentBySymbol(
    filter: InstrumentFilter,
    limit:  number,
  ): Promise<(StrategySignal & { id: number })[]> {
    const { rows } = await this.pool.query<SignalRow>(
      `select * from strategy_signals
       where symbol = $1 and exchange = $2 and deleted_at is null
       order by ts desc limit $3`,
      [filter.symbol, filter.exchange, limit],
    );
    return rows.map(rowToSignal).reverse();
  }
}

// ─── In-memory ────────────────────────────────────────────────────────────

export class InMemorySignalStore implements SignalStore {
  private rows: ((StrategySignal & { id: number; deletedAt: string | null }))[] = [];
  private nextId = 1;

  private key(s: Pick<StrategySignal, "symbol" | "exchange" | "timeframe" | "ts" | "strategyId" | "strategyVersion">): string {
    return `${s.symbol}|${s.exchange}|${s.timeframe}|${s.ts}|${s.strategyId}|${s.strategyVersion}`;
  }

  async insert(s: StrategySignal): Promise<StrategySignal & { id: number }> {
    const k = this.key(s);
    if (this.rows.some((r) => this.key(r) === k && r.deletedAt === null)) {
      throw new Error(`duplicate signal: ${k}`);
    }
    const row = { id: this.nextId++, deletedAt: null as string | null, ...s };
    this.rows.push(row);
    const { deletedAt: _, ...visible } = row;
    return visible;
  }

  async retract(id: number, _reason?: string): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r && r.deletedAt === null) r.deletedAt = new Date().toISOString();
  }

  async fetchActiveByStrategy(
    strategyId: string,
    range:      TimeRange,
  ): Promise<(StrategySignal & { id: number })[]> {
    return this.rows
      .filter((r) =>
        r.strategyId === strategyId &&
        r.deletedAt === null &&
        r.ts >= range.startTs && r.ts < range.endTs)
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .map(({ deletedAt: _, ...x }) => x);
  }

  async fetchRecentBySymbol(
    filter: InstrumentFilter,
    limit:  number,
  ): Promise<(StrategySignal & { id: number })[]> {
    return this.rows
      .filter((r) =>
        r.symbol === filter.symbol &&
        r.exchange === filter.exchange &&
        r.deletedAt === null)
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, limit)
      .reverse()
      .map(({ deletedAt: _, ...x }) => x);
  }
}
