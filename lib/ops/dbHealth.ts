/**
 * lib/ops/dbHealth.ts
 *
 * P11.1 — lightweight, read-only DB reachability + pool config diagnostic.
 * Deliberately does NOT retry: a health check that retries before reporting
 * unhealthy defeats its own purpose. It should reflect the DB's real-time
 * reachability, unmasked by the same withDbRetry() that the ops summary
 * routes use to smooth over one-off blips.
 *
 * Uses pool.query() (not withPooledClient) — a single ad hoc statement that
 * pg checks out, runs, and releases internally without a manual client
 * handle to babysit.
 */
import type { Pool } from "pg";
import { resolvePgPoolConfig } from "@/lib/storage/clients";

export interface DbHealthPoolConfigSummary {
  runtime: "serverless" | "worker" | "local";
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statementTimeoutMillis: number;
  queryTimeoutMillis: number;
}

export interface DbHealthSummary {
  generatedAt: string;
  ok: boolean;
  latencyMs: number | null;
  dbTime: string | null;
  poolConfig: DbHealthPoolConfigSummary;
  error: string | null;
}

function poolConfigSummary(env: NodeJS.ProcessEnv): DbHealthPoolConfigSummary {
  const config = resolvePgPoolConfig(env);
  return {
    runtime: config.runtime,
    max: config.max,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    statementTimeoutMillis: config.statementTimeoutMillis,
    queryTimeoutMillis: config.queryTimeoutMillis,
  };
}

export async function loadDbHealth(input: {
  pool: Pool;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<DbHealthSummary> {
  const now = input.now ?? new Date();
  const env = input.env ?? process.env;
  const poolConfig = poolConfigSummary(env);
  const generatedAt = now.toISOString();
  const start = Date.now();

  try {
    const { rows } = await input.pool.query<{ db_now: Date }>("select now() as db_now");
    return {
      generatedAt,
      ok: true,
      latencyMs: Date.now() - start,
      dbTime: rows[0]?.db_now ? new Date(rows[0].db_now).toISOString() : null,
      poolConfig,
      error: null,
    };
  } catch (err) {
    return {
      generatedAt,
      ok: false,
      latencyMs: null,
      dbTime: null,
      poolConfig,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
