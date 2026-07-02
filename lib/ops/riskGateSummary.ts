/**
 * lib/ops/riskGateSummary.ts
 *
 * P11: read-only ops visibility into the scheduled risk gate. Mirrors the
 * P8 ops summary conventions (lib/ops/p8Summary.ts): a pure builder over
 * plain row shapes, plus a thin Postgres-backed loader. No mutations, no
 * job enqueue/claim, no OpenAI.
 */
import type { Pool } from "pg";
import { RISK_VERSION } from "@/lib/versions";

export interface RiskGateDecisionCountRow {
  approved: boolean;
  count: number | string;
}

export interface RiskGateBlockedByRow {
  blocked_by: string[] | null;
}

export interface RiskGateApprovedIntentRow {
  public_id: string;
  symbol: string;
  exchange: string;
  direction: string;
  suggested_size: number | string | null;
  entry_price: number | string | null;
  stop_loss: number | string | null;
  take_profit: number | string | null;
  risk_version: string;
  created_at: Date | string | null;
}

export interface RiskGateRejectedDecisionRow {
  public_id: string;
  signal_id: number | string;
  symbol: string;
  exchange: string;
  reason: string;
  blocked_by: string[] | null;
  warnings: string[] | null;
  risk_version: string;
  evaluated_at: Date | string;
}

export interface RiskGateOpsBuildInput {
  now?: Date;
  counts?: RiskGateDecisionCountRow[];
  blockedByRows?: RiskGateBlockedByRow[];
  latestApprovedIntent?: RiskGateApprovedIntentRow | null;
  latestRejectedDecision?: RiskGateRejectedDecisionRow | null;
}

export interface RiskGateOpsSummary {
  generatedAt: string;
  riskEngineVersion: string;
  signalsEvaluated: number;
  approvedCount: number;
  rejectedCount: number;
  topBlockedByReasons: Array<{ code: string; count: number }>;
  latestApprovedIntent: {
    id: string;
    symbol: string;
    exchange: string;
    direction: string;
    suggestedSize: number;
    entryPrice: number;
    stopLoss: number | null;
    takeProfit: number | null;
    riskVersion: string;
    createdAt: string | null;
  } | null;
  /**
   * Rejected scheduled signals never create a trade intent — this is the
   * latest rejected risk decision, not an intent. Named accordingly so the
   * ops summary doesn't imply an intent exists where none was created.
   */
  latestRejectedDecision: {
    riskDecisionId: string;
    signalId: number;
    symbol: string;
    exchange: string;
    reason: string;
    blockedBy: string[];
    warnings: string[];
    riskVersion: string;
    evaluatedAt: string;
  } | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function numeric(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function topBlockedByReasons(rows: RiskGateBlockedByRow[], limit = 5): Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const code of row.blocked_by ?? []) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([code, count]) => ({ code, count }));
}

export function buildRiskGateSummary(input: RiskGateOpsBuildInput = {}): RiskGateOpsSummary {
  const now = input.now ?? new Date();
  const counts = input.counts ?? [];
  const approvedCount = numeric(counts.find((row) => row.approved === true)?.count);
  const rejectedCount = numeric(counts.find((row) => row.approved === false)?.count);

  const approvedIntent = input.latestApprovedIntent ?? null;
  const rejectedDecision = input.latestRejectedDecision ?? null;

  return {
    generatedAt: now.toISOString(),
    riskEngineVersion: RISK_VERSION,
    signalsEvaluated: approvedCount + rejectedCount,
    approvedCount,
    rejectedCount,
    topBlockedByReasons: topBlockedByReasons(input.blockedByRows ?? []),
    latestApprovedIntent: approvedIntent === null ? null : {
      id: approvedIntent.public_id,
      symbol: approvedIntent.symbol,
      exchange: approvedIntent.exchange,
      direction: approvedIntent.direction,
      suggestedSize: numeric(approvedIntent.suggested_size),
      entryPrice: numeric(approvedIntent.entry_price),
      stopLoss: approvedIntent.stop_loss === null ? null : numeric(approvedIntent.stop_loss),
      takeProfit: approvedIntent.take_profit === null ? null : numeric(approvedIntent.take_profit),
      riskVersion: approvedIntent.risk_version,
      createdAt: nullableIso(approvedIntent.created_at),
    },
    latestRejectedDecision: rejectedDecision === null ? null : {
      riskDecisionId: rejectedDecision.public_id,
      signalId: numeric(rejectedDecision.signal_id),
      symbol: rejectedDecision.symbol,
      exchange: rejectedDecision.exchange,
      reason: rejectedDecision.reason,
      blockedBy: [...(rejectedDecision.blocked_by ?? [])],
      warnings: [...(rejectedDecision.warnings ?? [])],
      riskVersion: rejectedDecision.risk_version,
      evaluatedAt: iso(rejectedDecision.evaluated_at),
    },
  };
}

export async function loadRiskGateSummary(input: { pool: Pool; now?: Date }): Promise<RiskGateOpsSummary> {
  const countsQuery = input.pool.query<{ approved: boolean; count: string }>(
    `select approved, count(*)::text as count from risk_decisions group by approved`,
  );
  const blockedByQuery = input.pool.query<RiskGateBlockedByRow>(
    `select blocked_by from risk_decisions where approved = false`,
  );
  const approvedIntentQuery = input.pool.query<RiskGateApprovedIntentRow>(
    `select public_id::text, symbol, exchange, direction, suggested_size, entry_price,
            stop_loss, take_profit, risk_version, created_at
     from trade_intents
     where status = 'risk_approved'
     order by coalesce(created_at, inserted_at) desc, id desc
     limit 1`,
  );
  const rejectedDecisionQuery = input.pool.query<RiskGateRejectedDecisionRow>(
    `select public_id::text, signal_id, symbol, exchange, reason, blocked_by, warnings,
            risk_version, evaluated_at
     from risk_decisions
     where approved = false
     order by evaluated_at desc, id desc
     limit 1`,
  );

  const [counts, blockedByRows, approvedIntent, rejectedDecision] = await Promise.all([
    countsQuery,
    blockedByQuery,
    approvedIntentQuery,
    rejectedDecisionQuery,
  ]);

  return buildRiskGateSummary({
    now: input.now,
    counts: counts.rows,
    blockedByRows: blockedByRows.rows,
    latestApprovedIntent: approvedIntent.rows[0] ?? null,
    latestRejectedDecision: rejectedDecision.rows[0] ?? null,
  });
}
