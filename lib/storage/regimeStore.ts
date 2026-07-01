/**
 * lib/storage/regimeStore.ts
 */
import type { Pool } from "pg";
import type { Exchange, RegimeContext, RegimeLabel } from "@/lib/quant/types";
import type { RegimeStore, RegimeSnapshotRow, InstrumentFilter } from "./interfaces";

interface DbRow {
  id:                    number;
  symbol:                string;
  exchange:              string;
  ts:                    Date;
  regime:                string;
  reliability:           string;
  directional_bias:      string;
  trade_permission:      string;
  edge_multiplier:       string;
  size_multiplier:       string;
  reason:                string | null;
  raw_response:          unknown;
  regime_model_version:  string;
  prompt_version:        string | null;
  feature_version:       string | null;
  source_lineage:        unknown;
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

function rowToSnapshot(row: DbRow): RegimeSnapshotRow & { id: number } {
  return {
    id:                  row.id,
    symbol:              row.symbol,
    exchange:            row.exchange as Exchange,
    ts:                  row.ts.toISOString(),
    regime:              row.regime as RegimeLabel,
    reliability:         Number(row.reliability),
    directionalBias:     row.directional_bias as "UP" | "DOWN" | "NEUTRAL",
    tradePermission:     row.trade_permission,
    edgeMultiplier:      Number(row.edge_multiplier),
    sizeMultiplier:      Number(row.size_multiplier),
    reason:              row.reason,
    rawResponse:         row.raw_response,
    regimeModelVersion:  row.regime_model_version,
    promptVersion:       row.prompt_version,
    featureVersion:      row.feature_version,
    sourceLineage:       parseJsonObject(row.source_lineage) as RegimeSnapshotRow["sourceLineage"],
  };
}

export class PgRegimeStore implements RegimeStore {
  constructor(private readonly pool: Pool) {}

  async insert(r: RegimeSnapshotRow): Promise<RegimeSnapshotRow & { id: number }> {
    const { rows } = await this.pool.query<DbRow>(
      `insert into regime_snapshots (
         symbol, exchange, ts,
         regime, reliability, directional_bias, trade_permission,
         edge_multiplier, size_multiplier, reason, raw_response,
         regime_model_version, prompt_version, feature_version, source_lineage)
       values ($1,$2,$3, $4,$5,$6,$7, $8,$9,$10,$11, $12,$13,$14,$15)
       returning *`,
      [
        r.symbol, r.exchange, r.ts,
        r.regime, r.reliability, r.directionalBias, r.tradePermission,
        r.edgeMultiplier, r.sizeMultiplier, r.reason ?? null,
        r.rawResponse === undefined ? null : JSON.stringify(r.rawResponse),
        r.regimeModelVersion, r.promptVersion ?? null, r.featureVersion ?? null,
        JSON.stringify(r.sourceLineage ?? {}),
      ],
    );
    return rowToSnapshot(rows[0]);
  }

  async latest(filter: InstrumentFilter): Promise<RegimeSnapshotRow | null> {
    const { rows } = await this.pool.query<DbRow>(
      `select * from regime_snapshots
       where symbol = $1 and exchange = $2
       order by ts desc limit 1`,
      [filter.symbol, filter.exchange],
    );
    return rows[0] ? rowToSnapshot(rows[0]) : null;
  }

  async fetchRecent(filter: InstrumentFilter, limit: number): Promise<RegimeSnapshotRow[]> {
    const { rows } = await this.pool.query<DbRow>(
      `select * from regime_snapshots
       where symbol = $1 and exchange = $2
       order by ts desc limit $3`,
      [filter.symbol, filter.exchange, limit],
    );
    return rows.map(rowToSnapshot);
  }

  async latestAsContext(filter: InstrumentFilter): Promise<RegimeContext | null> {
    const latest = await this.latest(filter);
    if (!latest) return null;
    return { regime: latest.regime, reliability: latest.reliability, ts: latest.ts };
  }
}

// ─── In-memory ────────────────────────────────────────────────────────────

export class InMemoryRegimeStore implements RegimeStore {
  private rows: (RegimeSnapshotRow & { id: number })[] = [];
  private nextId = 1;

  async insert(r: RegimeSnapshotRow): Promise<RegimeSnapshotRow & { id: number }> {
    const row = { id: this.nextId++, ...r };
    this.rows.push(row);
    return row;
  }

  async latest(filter: InstrumentFilter): Promise<RegimeSnapshotRow | null> {
    const sorted = this.rows
      .filter((r) => r.symbol === filter.symbol && r.exchange === filter.exchange)
      .sort((a, b) => b.ts.localeCompare(a.ts));
    return sorted[0] ?? null;
  }

  async fetchRecent(filter: InstrumentFilter, limit: number): Promise<RegimeSnapshotRow[]> {
    return this.rows
      .filter((r) => r.symbol === filter.symbol && r.exchange === filter.exchange)
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, limit);
  }

  async latestAsContext(filter: InstrumentFilter): Promise<RegimeContext | null> {
    const latest = await this.latest(filter);
    return latest ? { regime: latest.regime, reliability: latest.reliability, ts: latest.ts } : null;
  }
}
