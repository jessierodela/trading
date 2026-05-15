/**
 * lib/storage/clients.ts
 *
 * Database client management for the storage layer.
 *
 * Today this exports getPgPool() for direct Postgres connections — used by
 * the worker (Railway) for both reads and writes. Long-lived, pooled.
 *
 * NOT YET EXPORTED: a supabase-js read client. When the Next.js API routes
 * are wired to the new tables, that client lives here too — keeps both
 * connection paths in one place. Vercel serverless can't hold pg pools
 * efficiently across cold starts (each invocation reopens; Supabase free
 * tier connection limit hurts fast), so reads from Vercel should go through
 * supabase-js (REST over Postgrest). Worker reads/writes use pg.
 *
 * Environment variables:
 *   SUPABASE_DB_URL    Direct Postgres connection string (worker only).
 *                       NOT the supabase-js URL — find it in Supabase
 *                       dashboard → Project Settings → Database → Connection
 *                       string → "URI" tab → use the "Session pooler" or
 *                       direct connection based on deployment.
 *   DATABASE_URL       Fallback used in tests / local dev.
 *
 * Connection pooling:
 *   Default pool size: 10. Tune up for ingestion bursts if needed.
 *   Idle timeout: 30s — short enough that Supabase doesn't kill idle
 *   connections out from under us, long enough to amortize reconnect cost.
 */
import { Pool } from "pg";

let pool: Pool | null = null;

export function getPgPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "SUPABASE_DB_URL (or DATABASE_URL for local) must be set. " +
      "Look in Supabase dashboard → Project Settings → Database → Connection string."
    );
  }

  pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    // SSL is required for hosted Supabase. The pg driver picks it up from
    // ?sslmode=require in the connection string. For local dev (no SSL) the
    // string omits it. Don't force it here.
  });

  // Avoid noisy ECONNRESET tracebacks during normal shutdown.
  pool.on("error", (err) => {
    console.error("[storage/clients] pg pool error:", err.message);
  });

  return pool;
}

/**
 * Close the pool. Call from worker shutdown handlers. Resets the singleton
 * so subsequent getPgPool() rebuilds.
 */
export async function closePgPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
