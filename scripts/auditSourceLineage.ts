import type { Pool } from "pg";
import { pathToFileURL } from "node:url";
import { closePgPool, getPgPool } from "@/lib/storage";

export interface SourceLineageAuditIssue {
  code: string;
  severity: "warn" | "block";
  message: string;
  table?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface SourceLineageTableSummary {
  table: string;
  totalRows: number;
  missingLineageRows: number;
  usdtRows?: number;
  canonicalUsdtRows?: number;
  distinctQuotes?: string[];
}

export interface SourceLineageAuditReport {
  ok: boolean;
  strict: boolean;
  checkedAt: string;
  issues: SourceLineageAuditIssue[];
  tables: SourceLineageTableSummary[];
}

const LINEAGE_TABLES = [
  "market_bars",
  "feature_snapshots",
  "regime_snapshots",
  "strategy_signals",
] as const;

function strictMode(): boolean {
  return process.env.SOURCE_LINEAGE_STRICT === "1" || process.argv.includes("--strict");
}

export function buildSourceLineageAuditReport(input: {
  checkedAt: string;
  strict: boolean;
  tables: SourceLineageTableSummary[];
  issues?: SourceLineageAuditIssue[];
}): SourceLineageAuditReport {
  const issues = [...(input.issues ?? [])];
  for (const table of input.tables) {
    if (table.missingLineageRows > 0) {
      issues.push({
        code: "SOURCE_LINEAGE_ROWS_MISSING",
        severity: "warn",
        message: `${table.table} has rows without persisted source_lineage.`,
        table: table.table,
        actual: { rows: table.missingLineageRows, totalRows: table.totalRows },
      });
    }
    if ((table.canonicalUsdtRows ?? 0) > 0) {
      issues.push({
        code: "CANONICAL_SYMBOL_HAS_USDT_LINEAGE",
        severity: "block",
        message: `${table.table} has canonical BTC-USD rows carrying USDT vendor/quote metadata.`,
        table: table.table,
        expected: "BTC-USD/USD",
        actual: { rows: table.canonicalUsdtRows },
      });
    }
  }

  return {
    ok: !issues.some((issue) => issue.severity === "block"),
    strict: input.strict,
    checkedAt: input.checkedAt,
    issues,
    tables: input.tables,
  };
}

async function existingColumns(pool: Pool, table: string): Promise<Set<string>> {
  const { rows } = await pool.query<{ column_name: string }>(
    `select column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name = $1`,
    [table],
  );
  return new Set(rows.map((row) => row.column_name));
}

async function auditMarketLikeTable(pool: Pool, table: "market_bars" | "feature_snapshots"): Promise<{
  summary: SourceLineageTableSummary;
  issues: SourceLineageAuditIssue[];
}> {
  const columns = await existingColumns(pool, table);
  const required = ["source", "vendor_symbol", "quote_asset", "source_lineage"];
  const missingColumns = required.filter((column) => !columns.has(column));
  if (missingColumns.length > 0) {
    return {
      summary: { table, totalRows: 0, missingLineageRows: 0 },
      issues: [{
        code: "SOURCE_LINEAGE_SCHEMA_MISSING",
        severity: "block",
        message: `${table} is missing source-lineage columns.`,
        table,
        expected: required,
        actual: missingColumns,
      }],
    };
  }

  const { rows } = await pool.query<{
    total_rows: number;
    missing_lineage_rows: number;
    usdt_rows: number;
    canonical_usdt_rows: number;
    distinct_quotes: string[] | null;
  }>(
    `select
       count(*)::integer as total_rows,
       count(*) filter (where source_lineage = '{}'::jsonb)::integer as missing_lineage_rows,
       count(*) filter (where quote_asset = 'USDT' or vendor_symbol ilike '%USDT%')::integer as usdt_rows,
       count(*) filter (
         where symbol = 'BTC-USD'
           and (quote_asset = 'USDT' or vendor_symbol ilike '%USDT%')
       )::integer as canonical_usdt_rows,
       array_remove(array_agg(distinct quote_asset), null) as distinct_quotes
     from ${table}`,
  );
  const row = rows[0];
  return {
    summary: {
      table,
      totalRows: row.total_rows,
      missingLineageRows: row.missing_lineage_rows,
      usdtRows: row.usdt_rows,
      canonicalUsdtRows: row.canonical_usdt_rows,
      distinctQuotes: row.distinct_quotes ?? [],
    },
    issues: [],
  };
}

async function auditLineageOnlyTable(pool: Pool, table: "regime_snapshots" | "strategy_signals"): Promise<{
  summary: SourceLineageTableSummary;
  issues: SourceLineageAuditIssue[];
}> {
  const columns = await existingColumns(pool, table);
  if (!columns.has("source_lineage")) {
    return {
      summary: { table, totalRows: 0, missingLineageRows: 0 },
      issues: [{
        code: "SOURCE_LINEAGE_SCHEMA_MISSING",
        severity: "block",
        message: `${table} is missing source_lineage.`,
        table,
        expected: "source_lineage",
        actual: "missing",
      }],
    };
  }

  const { rows } = await pool.query<{
    total_rows: number;
    missing_lineage_rows: number;
  }>(
    `select
       count(*)::integer as total_rows,
       count(*) filter (where source_lineage = '{}'::jsonb)::integer as missing_lineage_rows
     from ${table}`,
  );
  return {
    summary: {
      table,
      totalRows: rows[0].total_rows,
      missingLineageRows: rows[0].missing_lineage_rows,
    },
    issues: [],
  };
}

export async function auditSourceLineage(pool: Pool, strict: boolean): Promise<SourceLineageAuditReport> {
  const tables: SourceLineageTableSummary[] = [];
  const issues: SourceLineageAuditIssue[] = [];

  for (const table of LINEAGE_TABLES) {
    const result = table === "market_bars" || table === "feature_snapshots"
      ? await auditMarketLikeTable(pool, table)
      : await auditLineageOnlyTable(pool, table);
    tables.push(result.summary);
    issues.push(...result.issues);
  }

  return buildSourceLineageAuditReport({
    checkedAt: new Date().toISOString(),
    strict,
    tables,
    issues,
  });
}

function printReport(report: SourceLineageAuditReport): void {
  console.log("=== source lineage audit ===");
  console.log(`checkedAt: ${report.checkedAt}`);
  console.log(`strict: ${report.strict ? "yes" : "no"}`);
  for (const table of report.tables) {
    console.log(
      `${table.table}: total=${table.totalRows} missingLineage=${table.missingLineageRows}` +
      (table.usdtRows === undefined ? "" : ` usdtRows=${table.usdtRows} canonicalUsdtRows=${table.canonicalUsdtRows ?? 0}`),
    );
  }
  if (report.issues.length === 0) {
    console.log("issues: none");
  } else {
    console.log("issues:");
    for (const issue of report.issues) {
      console.log(`- ${issue.severity} ${issue.code}${issue.table ? ` table=${issue.table}` : ""}: ${issue.message}`);
    }
  }
}

async function main(): Promise<void> {
  const strict = strictMode();
  const hasDb = Boolean(process.env.SUPABASE_DB_URL?.trim() || process.env.DATABASE_URL?.trim());
  if (!hasDb) {
    console.log("SKIP: SUPABASE_DB_URL or DATABASE_URL is not set; source-lineage audit needs a configured database.");
    process.exit(strict ? 1 : 0);
  }

  const pool = getPgPool();
  try {
    const report = await auditSourceLineage(pool, strict);
    printReport(report);
    const hasStrictIssue = report.issues.some((issue) => issue.severity === "block");
    process.exit(strict && hasStrictIssue ? 1 : 0);
  } finally {
    await closePgPool();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    await closePgPool().catch(() => undefined);
    process.exit(1);
  });
}
