/**
 * lib/storage/featureStore.ts
 *
 * Implementations of FeatureStore.
 */
import type { Pool } from "pg";
import type { FeatureSnapshot, Exchange, Timeframe } from "@/lib/quant/types";
import type { FeatureStore, InstrumentFilter, TimeRange } from "./interfaces";
import { validateFeatureSnapshot } from "./validators";

// ─── Column definitions ────────────────────────────────────────────────────
// Single source of truth for the column ↔ field mapping. Adding a feature
// means adding one entry here and to the FeatureSnapshot type. Adding a
// column-only field (rare) means listing it here without a field entry.

interface ColMap {
  col:   string;
  field: keyof FeatureSnapshot;
}

const FEATURE_COLS: ColMap[] = [
  { col: "rsi14",                    field: "rsi14" },
  { col: "macd",                     field: "macd" },
  { col: "macd_signal",              field: "macdSignal" },
  { col: "macd_hist",                field: "macdHist" },
  { col: "ema20",                    field: "ema20" },
  { col: "ema50",                    field: "ema50" },
  { col: "ema200",                   field: "ema200" },
  { col: "ema20_slope",              field: "ema20Slope" },
  { col: "ema50_slope",              field: "ema50Slope" },
  { col: "ema200_slope",             field: "ema200Slope" },
  { col: "atr14",                    field: "atr14" },
  { col: "atr_pct",                  field: "atrPct" },
  { col: "bb_upper",                 field: "bbUpper" },
  { col: "bb_middle",                field: "bbMiddle" },
  { col: "bb_lower",                 field: "bbLower" },
  { col: "bb_width",                 field: "bbWidth" },
  { col: "bb_width_prev",            field: "bbWidthPrev" },
  { col: "volume_sma20",             field: "volumeSma20" },
  { col: "relative_volume20",        field: "relativeVolume20" },
  { col: "distance_from_ema20_atr",  field: "distanceFromEma20Atr" },
  { col: "candle_range_atr",         field: "candleRangeAtr" },
  { col: "daily_ema50_above_ema200", field: "daily_ema50AboveEma200" },
  { col: "daily_price_above_ema200", field: "daily_priceAboveEma200" },
];

interface FeatureRow {
  id:                       number;
  bar_id:                   number;
  symbol:                   string;
  exchange:                 string;
  timeframe:                string;
  ts:                       Date;
  close:                    string;
  feature_version:          string;
  extras:                   Record<string, unknown> | null;
  [key: string]:            unknown;     // for the dynamic feature columns
}

function rowToFeature(row: FeatureRow): FeatureSnapshot & { id: number } {
  const out: FeatureSnapshot & { id: number } = {
    id:             row.id,
    symbol:         row.symbol,
    exchange:       row.exchange as Exchange,
    timeframe:      row.timeframe as Timeframe,
    ts:             row.ts.toISOString(),
    close:          Number(row.close),
    featureVersion: row.feature_version,
  };
  for (const { col, field } of FEATURE_COLS) {
    const v = row[col];
    if (v === null || v === undefined) continue;
    // Boolean columns stay boolean; numeric columns come back as string.
    (out as unknown as Record<string, unknown>)[field] = typeof v === "boolean" ? v : Number(v);
  }
  return out;
}

// ─── Postgres implementation ───────────────────────────────────────────────

export class PgFeatureStore implements FeatureStore {
  constructor(private readonly pool: Pool) {}

  private async _resolveBarId(s: FeatureSnapshot): Promise<number> {
    const { rows } = await this.pool.query<{ id: number }>(
      `select id from market_bars
       where symbol = $1 and exchange = $2 and timeframe = $3 and ts = $4`,
      [s.symbol, s.exchange, s.timeframe, s.ts],
    );
    if (rows.length === 0) {
      throw new Error(
        `Cannot insert FeatureSnapshot: no matching market_bars row ` +
        `(${s.symbol}/${s.exchange}/${s.timeframe}/${s.ts})`,
      );
    }
    return rows[0].id;
  }

  private _buildInsertArgs(s: FeatureSnapshot, barId: number): { cols: string[]; params: unknown[] } {
    const cols = ["bar_id", "symbol", "exchange", "timeframe", "ts", "close", "feature_version"];
    const params: unknown[] = [barId, s.symbol, s.exchange, s.timeframe, s.ts, s.close, s.featureVersion];
    for (const { col, field } of FEATURE_COLS) {
      const v = s[field];
      if (v === undefined || v === null) continue;
      cols.push(col);
      params.push(v);
    }
    return { cols, params };
  }

  async insert(s: FeatureSnapshot): Promise<FeatureSnapshot & { id: number }> {
    validateFeatureSnapshot(s);
    const barId = await this._resolveBarId(s);
    const { cols, params } = this._buildInsertArgs(s, barId);
    const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await this.pool.query<FeatureRow>(
      `insert into feature_snapshots (${cols.join(", ")})
       values (${placeholders})
       on conflict on constraint feature_snapshots_unique do nothing
       returning *`,
      params,
    );
    if (rows.length > 0) return rowToFeature(rows[0]);
    // Row already existed — fetch and return it.
    const { rows: existing } = await this.pool.query<FeatureRow>(
      `select * from feature_snapshots
       where symbol = $1 and exchange = $2 and timeframe = $3
         and ts = $4 and feature_version = $5`,
      [s.symbol, s.exchange, s.timeframe, s.ts, s.featureVersion],
    );
    return rowToFeature(existing[0]);
  }

  async insertMany(snapshots: FeatureSnapshot[]): Promise<number> {
    let inserted = 0;
    for (const s of snapshots) {
      validateFeatureSnapshot(s);
      const barId = await this._resolveBarId(s);
      const { cols, params } = this._buildInsertArgs(s, barId);
      const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
      const result = await this.pool.query(
        `insert into feature_snapshots (${cols.join(", ")})
         values (${placeholders})
         on conflict on constraint feature_snapshots_unique do nothing`,
        params,
      );
      if ((result.rowCount ?? 0) > 0) inserted++;
    }
    return inserted;
    // A real bulk insert with one round trip would do a CTE-based bar_id join.
    // Optimize when ingestion volume warrants it.
  }

  async fetchRange(
    filter: InstrumentFilter & { timeframe: Timeframe; featureVersion?: string },
    range:  TimeRange,
  ): Promise<FeatureSnapshot[]> {
    const versionClause = filter.featureVersion ? "and feature_version = $5" : "";
    const params: unknown[] = [filter.symbol, filter.exchange, filter.timeframe, range.startTs];
    if (filter.featureVersion) params.push(filter.featureVersion);
    params.push(range.endTs);
    // shift endTs to last position dynamically
    const endTsIdx = params.length;

    const { rows } = await this.pool.query<FeatureRow>(
      `select * from feature_snapshots
       where symbol = $1 and exchange = $2 and timeframe = $3
         and ts >= $4 and ts < $${endTsIdx}
         ${versionClause}
       order by ts asc`,
      params,
    );
    return rows.map(rowToFeature);
  }

  async fetchLatest(
    filter: InstrumentFilter & { timeframe: Timeframe; featureVersion?: string },
  ): Promise<FeatureSnapshot | null> {
    const versionClause = filter.featureVersion ? "and feature_version = $4" : "";
    const params: unknown[] = [filter.symbol, filter.exchange, filter.timeframe];
    if (filter.featureVersion) params.push(filter.featureVersion);

    const { rows } = await this.pool.query<FeatureRow>(
      `select * from feature_snapshots
       where symbol = $1 and exchange = $2 and timeframe = $3
         ${versionClause}
       order by ts desc limit 1`,
      params,
    );
    return rows[0] ? rowToFeature(rows[0]) : null;
  }
}

// ─── In-memory implementation ──────────────────────────────────────────────

export class InMemoryFeatureStore implements FeatureStore {
  private rows: (FeatureSnapshot & { id: number })[] = [];
  private nextId = 1;

  private key(s: Pick<FeatureSnapshot, "symbol" | "exchange" | "timeframe" | "ts" | "featureVersion">): string {
    return `${s.symbol}|${s.exchange}|${s.timeframe}|${s.ts}|${s.featureVersion}`;
  }

  async insert(s: FeatureSnapshot): Promise<FeatureSnapshot & { id: number }> {
    validateFeatureSnapshot(s);
    const k = this.key(s);
    const existing = this.rows.find((r) => this.key(r) === k);
    if (existing) return existing;
    const row = { id: this.nextId++, ...s };
    this.rows.push(row);
    return row;
  }

  async insertMany(snapshots: FeatureSnapshot[]): Promise<number> {
    let inserted = 0;
    for (const s of snapshots) {
      validateFeatureSnapshot(s);
      const k = this.key(s);
      if (!this.rows.some((r) => this.key(r) === k)) {
        this.rows.push({ id: this.nextId++, ...s });
        inserted++;
      }
    }
    return inserted;
  }

  async fetchRange(
    filter: InstrumentFilter & { timeframe: Timeframe; featureVersion?: string },
    range:  TimeRange,
  ): Promise<FeatureSnapshot[]> {
    return this.rows
      .filter((r) =>
        r.symbol === filter.symbol &&
        r.exchange === filter.exchange &&
        r.timeframe === filter.timeframe &&
        (!filter.featureVersion || r.featureVersion === filter.featureVersion) &&
        r.ts >= range.startTs && r.ts < range.endTs)
      .sort((a, b) => a.ts.localeCompare(b.ts));
  }

  async fetchLatest(
    filter: InstrumentFilter & { timeframe: Timeframe; featureVersion?: string },
  ): Promise<FeatureSnapshot | null> {
    const sorted = this.rows
      .filter((r) =>
        r.symbol === filter.symbol &&
        r.exchange === filter.exchange &&
        r.timeframe === filter.timeframe &&
        (!filter.featureVersion || r.featureVersion === filter.featureVersion))
      .sort((a, b) => b.ts.localeCompare(a.ts));
    return sorted[0] ?? null;
  }
}
