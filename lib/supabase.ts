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
 * This avoids a build-time throw when env vars are not available
 * during Next.js static page data collection.
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
    auth: { persistSession: false }, // server-side — no session needed
  });

  return _client;
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
