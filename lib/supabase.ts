/**
 * lib/supabase.ts
 *
 * Supabase client for the trading dashboard.
 * Separate project from your CRM — uses its own env vars.
 *
 * Add to .env.local:
 *   TRADING_SUPABASE_URL=https://xxxx.supabase.co
 *   TRADING_SUPABASE_SERVICE_KEY=your-service-role-key   ← not the anon key
 *
 * We use the service role key here because this runs server-side only
 * (API routes) and needs to write without RLS restrictions.
 * Never expose this key to the client.
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.TRADING_SUPABASE_URL;
const key = process.env.TRADING_SUPABASE_SERVICE_KEY;

if (!url || !key) {
  throw new Error(
    "[supabase] TRADING_SUPABASE_URL or TRADING_SUPABASE_SERVICE_KEY is not set"
  );
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false }, // server-side — no session needed
});