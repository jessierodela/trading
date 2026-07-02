/**
 * lib/storage/clients.ts
 *
 * Database client management for the storage layer.
 *
 * Exports getPgPool() for direct Postgres connections — used by the Linux
 * worker (long-lived, pooled) and by Vercel serverless API routes (short-
 * lived, single-connection-per-invocation).
 *
 * Environment variables (connection):
 *   SUPABASE_DB_URL    Direct Postgres connection string.
 *                       NOT the supabase-js URL — find it in Supabase
 *                       dashboard → Project Settings → Database → Connection
 *                       string → "URI" tab → use the "Session pooler" or
 *                       direct connection based on deployment.
 *   DATABASE_URL       Fallback used in tests / local dev.
 *
 * P11.1 — DB stability hardening:
 *
 *   Pool sizing/timeouts are environment-aware. A serverless invocation
 *   (Vercel) should hold at most one connection and fail fast rather than
 *   queue forever waiting for a slot in a pooler with a hard connection cap
 *   (Supabase transaction-mode pooler). A long-running worker process can
 *   afford a small fixed pool since it's a single process, not N concurrent
 *   lambda instances each opening their own pool.
 *
 *   Runtime is detected as:
 *     - "serverless" when VERCEL / VERCEL_ENV is present
 *     - "worker" / "local" otherwise, distinguished by the explicit
 *       PG_POOL_RUNTIME env var (the worker entrypoint sets this — see
 *       scripts/runJobWorker.ts) since there's no reliable ambient signal
 *       that separates a systemd-managed worker from a developer's laptop.
 *     - PG_POOL_RUNTIME always wins over auto-detection when set.
 *
 *   Env vars (all optional, sane defaults below):
 *     PG_POOL_RUNTIME                 "serverless" | "worker" | "local"
 *     PG_POOL_MAX                     overrides the chosen runtime's max
 *     PG_POOL_MAX_SERVERLESS          default 1
 *     PG_POOL_MAX_WORKER              default 2
 *     PG_POOL_IDLE_TIMEOUT_MS         default 10s serverless / 30s worker+local
 *     PG_POOL_CONNECTION_TIMEOUT_MS   default 5s serverless / 10s worker+local
 *     PG_POOL_STATEMENT_TIMEOUT_MS    default 30s
 *     PG_POOL_QUERY_TIMEOUT_MS        default 15s serverless / 30s worker+local
 *
 *   The pool is cached on globalThis (not a plain module-level variable) so
 *   Next.js dev Fast Refresh re-executing this module doesn't silently spin
 *   up a second live Pool with a second "error" listener — a well-known
 *   Next.js + long-lived-connection footgun.
 */
import { Pool, type PoolClient } from "pg";

export type PgPoolRuntime = "serverless" | "worker" | "local";

const GLOBAL_POOL_KEY = Symbol.for("trading.storage.pgPool");

interface GlobalWithPool {
  [GLOBAL_POOL_KEY]?: Pool;
}

function globalSlot(): GlobalWithPool {
  return globalThis as GlobalWithPool;
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function detectPgPoolRuntime(env: NodeJS.ProcessEnv = process.env): PgPoolRuntime {
  const explicit = env.PG_POOL_RUNTIME?.trim().toLowerCase();
  if (explicit === "serverless" || explicit === "worker" || explicit === "local") return explicit;
  if (env.VERCEL === "1" || Boolean(env.VERCEL_ENV)) return "serverless";
  return "local";
}

const DEFAULT_MAX_BY_RUNTIME: Record<PgPoolRuntime, number> = {
  serverless: 1,
  worker: 2,
  local: 10,
};

const DEFAULT_IDLE_TIMEOUT_MS_BY_RUNTIME: Record<PgPoolRuntime, number> = {
  serverless: 10_000,
  worker: 30_000,
  local: 30_000,
};

const DEFAULT_CONNECTION_TIMEOUT_MS_BY_RUNTIME: Record<PgPoolRuntime, number> = {
  serverless: 5_000,
  worker: 10_000,
  local: 10_000,
};

const DEFAULT_QUERY_TIMEOUT_MS_BY_RUNTIME: Record<PgPoolRuntime, number> = {
  serverless: 15_000,
  worker: 30_000,
  local: 30_000,
};

const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

export interface ResolvedPgPoolConfig {
  runtime: PgPoolRuntime;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statementTimeoutMillis: number;
  queryTimeoutMillis: number;
}

function resolveMax(env: NodeJS.ProcessEnv, runtime: PgPoolRuntime): number {
  if (env.PG_POOL_MAX !== undefined) return envInt(env, "PG_POOL_MAX", DEFAULT_MAX_BY_RUNTIME[runtime]);
  const runtimeKey = runtime === "serverless" ? "PG_POOL_MAX_SERVERLESS" : runtime === "worker" ? "PG_POOL_MAX_WORKER" : "PG_POOL_MAX";
  return envInt(env, runtimeKey, DEFAULT_MAX_BY_RUNTIME[runtime]);
}

/** Pure — resolves pool sizing/timeouts for a given runtime + env, no side effects. Deterministic for tests. */
export function resolvePgPoolConfig(env: NodeJS.ProcessEnv = process.env, runtimeOverride?: PgPoolRuntime): ResolvedPgPoolConfig {
  const runtime = runtimeOverride ?? detectPgPoolRuntime(env);
  return {
    runtime,
    max: resolveMax(env, runtime),
    idleTimeoutMillis: envInt(env, "PG_POOL_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS_BY_RUNTIME[runtime]),
    connectionTimeoutMillis: envInt(env, "PG_POOL_CONNECTION_TIMEOUT_MS", DEFAULT_CONNECTION_TIMEOUT_MS_BY_RUNTIME[runtime]),
    statementTimeoutMillis: envInt(env, "PG_POOL_STATEMENT_TIMEOUT_MS", DEFAULT_STATEMENT_TIMEOUT_MS),
    queryTimeoutMillis: envInt(env, "PG_POOL_QUERY_TIMEOUT_MS", DEFAULT_QUERY_TIMEOUT_MS_BY_RUNTIME[runtime]),
  };
}

export interface GetPgPoolOptions {
  runtime?: PgPoolRuntime;
  env?: NodeJS.ProcessEnv;
}

export function getPgPool(options: GetPgPoolOptions = {}): Pool {
  const cached = globalSlot()[GLOBAL_POOL_KEY];
  if (cached) return cached;

  const env = options.env ?? process.env;
  const connectionString = env.SUPABASE_DB_URL ?? env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "SUPABASE_DB_URL (or DATABASE_URL for local) must be set. " +
      "Look in Supabase dashboard → Project Settings → Database → Connection string."
    );
  }

  const config = resolvePgPoolConfig(env, options.runtime);
  const created = new Pool({
    connectionString,
    max: config.max,
    idleTimeoutMillis: config.idleTimeoutMillis,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    statement_timeout: config.statementTimeoutMillis,
    query_timeout: config.queryTimeoutMillis,
    // SSL is required for hosted Supabase. The pg driver picks it up from
    // ?sslmode=require in the connection string. For local dev (no SSL) the
    // string omits it. Don't force it here.
  });

  // Required as of pg 8.x: an idle client in the pool that errors (e.g. the
  // connection is closed by the server/pooler) emits "error" on the pool.
  // Without a listener this crashes the process — this is the exact
  // EDBHANDLEREXITED crash observed on the Linux worker.
  created.on("error", (err) => {
    console.error(`[storage/clients] pg pool error (runtime=${config.runtime}):`, err.message);
  });

  globalSlot()[GLOBAL_POOL_KEY] = created;
  return created;
}

/**
 * Every explicit pool.connect() checkout must go through this helper.
 *
 * A client checked out of the pool (as opposed to one pool.query() manages
 * internally for a single statement) can emit its own "error" event if the
 * connection drops while checked out — e.g. mid-transaction. Node crashes
 * the process on an unhandled EventEmitter "error" with no listener, which
 * is the second half of the EDBHANDLEREXITED worker crash: the pool-level
 * handler above only covers idle clients back in the pool, not ones a
 * caller is actively holding. This wraps checkout, attaches a listener for
 * the lifetime of the checkout, and always releases — try/finally, so a
 * thrown error from fn() can never leak the client.
 */
export async function withPooledClient<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const onError = (err: Error) => {
    console.error("[storage/clients] checked-out client error:", err.message);
  };
  client.on("error", onError);
  try {
    return await fn(client);
  } finally {
    client.off("error", onError);
    client.release();
  }
}

/**
 * Close the pool. Call from worker shutdown handlers. Resets the singleton
 * so subsequent getPgPool() rebuilds.
 */
export async function closePgPool(): Promise<void> {
  const cached = globalSlot()[GLOBAL_POOL_KEY];
  if (cached) {
    await cached.end();
    globalSlot()[GLOBAL_POOL_KEY] = undefined;
  }
}
