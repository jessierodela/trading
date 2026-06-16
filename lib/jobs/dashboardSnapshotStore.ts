import type { Pool } from "pg";

export type DashboardSnapshotType = "dashboard" | "signals" | "regime" | "paper" | "telegram";

export interface DashboardSnapshotRecord {
  id: number;
  publicId: string;
  snapshotType: DashboardSnapshotType;
  symbol: string | null;
  timeframe: string | null;
  payload: unknown;
  sourceJobId: number | null;
  generatedAt: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface InsertDashboardSnapshotInput {
  snapshotType: DashboardSnapshotType;
  symbol?: string | null;
  timeframe?: string | null;
  payload: unknown;
  sourceJobId?: number | null;
  generatedAt?: string | Date;
  expiresAt?: string | Date | null;
}

export interface DashboardSnapshotFilter {
  snapshotType?: DashboardSnapshotType;
  symbol?: string | null;
  timeframe?: string | null;
  includeExpired?: boolean;
  limit?: number;
}

interface DashboardSnapshotRow {
  id: number;
  public_id: string;
  snapshot_type: string;
  symbol: string | null;
  timeframe: string | null;
  payload: unknown;
  source_job_id: number | null;
  generated_at: Date | string;
  expires_at: Date | string | null;
  created_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function rowToSnapshot(row: DashboardSnapshotRow): DashboardSnapshotRecord {
  return {
    id: row.id,
    publicId: row.public_id,
    snapshotType: row.snapshot_type as DashboardSnapshotType,
    symbol: row.symbol,
    timeframe: row.timeframe,
    payload: row.payload,
    sourceJobId: row.source_job_id,
    generatedAt: iso(row.generated_at),
    expiresAt: nullableIso(row.expires_at),
    createdAt: iso(row.created_at),
  };
}

function validateSnapshotType(snapshotType: string): asserts snapshotType is DashboardSnapshotType {
  if (!["dashboard", "signals", "regime", "paper", "telegram"].includes(snapshotType)) {
    throw new Error(`unknown dashboard snapshot type: ${snapshotType}`);
  }
}

export class DashboardSnapshotStore {
  constructor(private readonly pool: Pool) {}

  async insertSnapshot(input: InsertDashboardSnapshotInput): Promise<DashboardSnapshotRecord> {
    validateSnapshotType(input.snapshotType);
    const generatedAt = input.generatedAt ? iso(input.generatedAt) : new Date().toISOString();
    const expiresAt = input.expiresAt === undefined || input.expiresAt === null ? null : iso(input.expiresAt);
    const { rows } = await this.pool.query<DashboardSnapshotRow>(
      `insert into dashboard_snapshots (
         snapshot_type, symbol, timeframe, payload, source_job_id, generated_at, expires_at)
       values ($1, $2, $3, $4::jsonb, $5, $6::timestamptz, $7::timestamptz)
       returning *`,
      [
        input.snapshotType,
        input.symbol ?? null,
        input.timeframe ?? null,
        JSON.stringify(input.payload ?? {}),
        input.sourceJobId ?? null,
        generatedAt,
        expiresAt,
      ],
    );
    return rowToSnapshot(rows[0]);
  }

  async fetchLatestSnapshot(filter: DashboardSnapshotFilter = {}): Promise<DashboardSnapshotRecord | null> {
    const rows = await this.listSnapshots({ ...filter, limit: 1 });
    return rows[0] ?? null;
  }

  async listSnapshots(filter: DashboardSnapshotFilter = {}): Promise<DashboardSnapshotRecord[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      clauses.push(sql.replace("?", `$${values.length}`));
    };

    if (filter.snapshotType) {
      validateSnapshotType(filter.snapshotType);
      add("snapshot_type = ?", filter.snapshotType);
    }
    if (filter.symbol !== undefined) {
      if (filter.symbol === null) clauses.push("symbol is null");
      else add("symbol = ?", filter.symbol);
    }
    if (filter.timeframe !== undefined) {
      if (filter.timeframe === null) clauses.push("timeframe is null");
      else add("timeframe = ?", filter.timeframe);
    }
    if (!filter.includeExpired) {
      clauses.push("(expires_at is null or expires_at > now())");
    }

    const limit = filter.limit ?? 50;
    if (!Number.isInteger(limit) || limit <= 0 || limit > 500) throw new Error("limit must be an integer between 1 and 500");
    values.push(limit);

    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    const { rows } = await this.pool.query<DashboardSnapshotRow>(
      `select * from dashboard_snapshots
       ${where}
       order by generated_at desc, id desc
       limit $${values.length}`,
      values,
    );
    return rows.map(rowToSnapshot);
  }
}
