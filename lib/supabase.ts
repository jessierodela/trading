/**
 * lib/supabase.ts
 *
 * Supabase client for the trading dashboard.
 * Separate project from your CRM — uses its own env vars.
 *
 * Add to .env.local:
 *   TRADING_SUPABASE_URL=https://xxxx.supabase.co
 *   TRADING_SUPABASE_SERVICE_KEY=your-service-role-key  ← not the anon key
 *
 * We use the service role key here because this runs server-side only
 * (API routes) and needs to write without RLS restrictions.
 * Never expose this key to the client.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

/**
 * Returns the Supabase client, initializing it lazily on first call.
 * Note: on Vercel serverless, _client resets per invocation — that's
 * expected. The retry logic in withRetry() handles transient socket errors.
 */
export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.TRADING_SUPABASE_URL;
  const key = process.env.TRADING_SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    throw new Error(
      "[supabase] TRADING_SUPABASE_URL or TRADING_SUPABASE_SERVICE_KEY is not set"
    );
  }

  _client = createClient(url, key, {
    auth: { persistSession: false },
    global: {
      fetch: (url, options) =>
        fetch(url, { ...options, cache: "no-store" }),
    },
  });

  return _client;
}

/**
 * Retries a Supabase operation on transient network failures.
 * Handles ETIMEDOUT, UND_ERR_SOCKET, and other fetch-level errors
 * that occur when Vercel serverless spins up a fresh TLS connection.
 *
 * Usage:
 *   const { data, error } = await withRetry(() =>
 *     getSupabase().from("signal_runs").insert({ ... }).select("id").single()
 *   );
 */
const RETRYABLE = ["ETIMEDOUT", "UND_ERR_SOCKET", "fetch failed"];

export async function withRetry<T>(
  fn: () => Promise<T>,
  { retries = 3, delayMs = 300, label = "supabase" }: {
    retries?: number;
    delayMs?: number;
    label?: string;
  } = {}
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Reset client on retry so a fresh TLS connection is attempted
      if (attempt > 1) {
        _client = null;
      }

      const result = await fn();

      // Supabase wraps errors in { data, error } — surface them so
      // the caller can decide, but also check for retryable fetch errors
      // embedded in the error message.
      const asObj = result as any;
      if (asObj?.error?.message && isRetryable(asObj.error.message)) {
        throw new Error(asObj.error.message);
      }

      return result;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);

      if (!isRetryable(msg) || attempt === retries) {
        throw err;
      }

      console.warn(
        `[${label}] Retryable error on attempt ${attempt}/${retries}: ${msg} — retrying in ${delayMs}ms`
      );
      await sleep(delayMs * attempt); // linear backoff
    }
  }

  throw lastErr;
}

function isRetryable(msg: string): boolean {
  return RETRYABLE.some((pattern) => msg.includes(pattern));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @deprecated Use getSupabase() instead to avoid build-time initialization.
 * Kept for backwards compatibility — remove once all callers are updated.
 */
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return (getSupabase() as any)[prop];
  },
});
