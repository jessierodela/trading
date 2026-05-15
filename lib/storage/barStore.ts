/**
 * lib/storage/barStore.ts
 *
 * Implementations of BarStore. PgBarStore for production; InMemoryBarStore
 * for tests.
 */
import type { Pool, PoolClient } from "pg";
import type { Bar, Exchange, Timeframe } from "@/lib/quant/types";
import type { BarStore, InstrumentFilter, TimeRange } from "./interfaces";
import { validateBar } from "./validators";

// ─── Row mapping ───────────────────────────────────────────────────────────

interface BarRow {
  id:                  number;
  symbol:              string;
  exchange:            string;
  timeframe:           string;
  ts:                  Date;
  open:                string;          // numeric returns string from pg by default
  high:                string;
  low:                 string;
  close:               string;
  volume:              string | null;
  trade_count:         number | null;
  data_source_version: string;
}

function rowToBar(row: BarRow): Bar & { id: number } {
  return {
    id:          row.id,
    symbol:      row.symbol,
    exchange:    row.exchange as Exchange,
    timeframe:   row.timeframe as Timeframe,
    ts:          row.ts.toISOString(),
    open:        Number(row.open),
    high:        Number(row.high),
    low:         Number(row.low),
    close:       Number(row.close),
    volume:      row.volume === null ? null : Number(row.volume),
    tradeCount:  row.trade_count,
  };
}

// ─── Postgres implementation ───────────────────────────────────────────────

export class PgBarStore implements BarStore {
  constructor(private readonly pool: Pool) {}

  async insert(bar: Bar, dataSourceVersion: string): Promise<Bar & { id: number }> {
    validateBar(bar);
    const { rows } = await this.pool.query<BarRow>(
      `insert into market_bars
         (symbol, exchange, timeframe, ts, open, high, low, close, volume, trade_count, data_source_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning *`,
      [
        bar.symbol, bar.exchange, bar.timeframe, bar.ts,
        bar.open, bar.high, bar.low, bar.close,
        bar.volume, bar.tradeCount ?? null,
        dataSourceVersion,
      ],
    );
    return rowToBar(rows[0]);
  }

  async insertMany(
    bars:              Bar[],
    dataSourceVersion: string,
    opts:              { onConflict: "ignore" | "error" } = { onConflict: "error" },
  ): Promise<number> {
    if (bars.length === 0) return 0;
    for (const bar of bars) validateBar(bar);

    const cols = [
      "symbol", "exchange", "timeframe", "ts",
      "open", "high", "low", "close",
      "volume", "trade_count", "data_source_version",
    ];
    const valuesSql: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const bar of bars) {
      valuesSql.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(
        bar.symbol, bar.exchange, bar.timeframe, bar.ts,
        bar.open, bar.high, bar.low, bar.close,
        bar.volume, bar.tradeCount ?? null,
        dataSourceVersion,
      );
    }
    const conflictClause =
      opts.onConflict === "ignore"
        ? "on conflict (symbol, exchange, timeframe, ts) do nothing"
        : "";

    const sql = `
      insert into market_bars (${cols.join(", ")})
      values ${valuesSql.join(", ")}
      ${conflictClause}
    `;
    const result = await this.pool.query(sql, params);
    return result.rowCount ?? 0;
  }

  async fetchRange(
    filter: InstrumentFilter & { timeframe: Timeframe },
    range:  TimeRange,
  ): Promise<Bar[]> {
    const { rows } = await this.pool.query<BarRow>(
      `select * from market_bars
       where symbol = $1 and exchange = $2 and timeframe = $3
         and ts >= $4 and ts < $5
       order by ts asc`,
      [filter.symbol, filter.exchange, filter.timeframe, range.startTs, range.endTs],
    );
    return rows.map(rowToBar);
  }

  async fetchRecent(
    filter: InstrumentFilter & { timeframe: Timeframe },
    limit:  number,
  ): Promise<Bar[]> {
    const { rows } = await this.pool.query<BarRow>(
      `select * from market_bars
       where symbol = $1 and exchange = $2 and timeframe = $3
       order by ts desc
       limit $4`,
      [filter.symbol, filter.exchange, filter.timeframe, limit],
    );
    return rows.map(rowToBar).reverse();   // return ascending
  }

  async latestTs(filter: InstrumentFilter & { timeframe: Timeframe }): Promise<string | null> {
    const { rows } = await this.pool.query<{ ts: Date }>(
      `select ts from market_bars
       where symbol = $1 and exchange = $2 and timeframe = $3
       order by ts desc limit 1`,
      [filter.symbol, filter.exchange, filter.timeframe],
    );
    return rows[0]?.ts.toISOString() ?? null;
  }
}

// ─── In-memory implementation (tests) ──────────────────────────────────────

export class InMemoryBarStore implements BarStore {
  private rows: (Bar & { id: number })[] = [];
  private nextId = 1;

  private key(b: Pick<Bar, "symbol" | "exchange" | "timeframe" | "ts">): string {
    return `${b.symbol}|${b.exchange}|${b.timeframe}|${b.ts}`;
  }

  async insert(bar: Bar, _dataSourceVersion: string): Promise<Bar & { id: number }> {
    validateBar(bar);
    const k = this.key(bar);
    if (this.rows.some((r) => this.key(r) === k)) {
      throw new Error(`duplicate bar: ${k}`);
    }
    const row = { id: this.nextId++, ...bar };
    this.rows.push(row);
    return row;
  }

  async insertMany(
    bars:               Bar[],
    _dataSourceVersion: string,
    opts:               { onConflict: "ignore" | "error" } = { onConflict: "error" },
  ): Promise<number> {
    let inserted = 0;
    for (const bar of bars) {
      validateBar(bar);
      const k = this.key(bar);
      if (this.rows.some((r) => this.key(r) === k)) {
        if (opts.onConflict === "ignore") continue;
        throw new Error(`duplicate bar: ${k}`);
      }
      this.rows.push({ id: this.nextId++, ...bar });
      inserted++;
    }
    return inserted;
  }

  async fetchRange(
    filter: InstrumentFilter & { timeframe: Timeframe },
    range:  TimeRange,
  ): Promise<Bar[]> {
    return this.rows
      .filter((r) =>
        r.symbol === filter.symbol &&
        r.exchange === filter.exchange &&
        r.timeframe === filter.timeframe &&
        r.ts >= range.startTs &&
        r.ts <  range.endTs)
      .sort((a, b) => a.ts.localeCompare(b.ts));
  }

  async fetchRecent(
    filter: InstrumentFilter & { timeframe: Timeframe },
    limit:  number,
  ): Promise<Bar[]> {
    return this.rows
      .filter((r) => r.symbol === filter.symbol && r.exchange === filter.exchange && r.timeframe === filter.timeframe)
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, limit)
      .reverse();
  }

  async latestTs(filter: InstrumentFilter & { timeframe: Timeframe }): Promise<string | null> {
    const sorted = this.rows
      .filter((r) => r.symbol === filter.symbol && r.exchange === filter.exchange && r.timeframe === filter.timeframe)
      .map((r) => r.ts)
      .sort((a, b) => b.localeCompare(a));
    return sorted[0] ?? null;
  }
}

// Helper: unused but kept for symmetry with future stores that need a txn.
export type _BarTxn = PoolClient;
