/**
 * app/api/signals/route.ts
 * Fetches Taapi indicators for all assets, runs signal evaluation,
 * and returns agent results + stats + activity log.
 *
 * GET /api/signals
 * Response: { agentResults, stats, activity }
 *
 * RATE LIMIT PROTECTION:
 * - In-memory mutex prevents concurrent fetches from running in parallel.
 *   If a second request arrives while a fetch is in progress, it waits for
 *   the first to complete and returns the same result — no double TAAPI calls.
 * - Results are cached for CACHE_TTL_MS. Requests within the window get the
 *   cached result instantly without hitting TAAPI at all.
 */

import { NextResponse } from "next/server";
import { fetchAllIndicators } from "@/lib/taapi";
import { fetchAllQuotes }     from "@/lib/polygon";
import { evaluateSignals }    from "@/lib/signals";
import { WATCHLIST }          from "@/config/assets";

export const dynamic = "force-dynamic";

// ─── Cache + mutex ────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000; // return cached result for 60s

interface CachedResult {
  data:      ReturnType<typeof evaluateSignals>;
  fetchedAt: number;
}

let cache:       CachedResult | null = null;
let fetchPromise: Promise<CachedResult> | null = null;

async function getSignals(): Promise<CachedResult> {
  // 1. Return cache if fresh
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    console.log(`[api/signals] Returning cached result (age: ${Math.round((Date.now() - cache.fetchedAt) / 1000)}s)`);
    return cache;
  }

  // 2. If a fetch is already in flight, wait for it — don't start a second one
  if (fetchPromise) {
    console.log("[api/signals] Fetch already in progress — waiting for existing cycle...");
    return fetchPromise;
  }

  // 3. Start a new fetch, store the promise so concurrent callers share it
  fetchPromise = (async () => {
    try {
      console.log("[api/signals] Starting new fetch cycle...");

      const allAssets    = WATCHLIST.map((a) => ({ symbol: a.symbol, type: a.type }));
      const stockAssets  = WATCHLIST.filter((a) => a.type === "stock");
      const cryptoAssets = WATCHLIST.filter((a) => a.type === "crypto");

      const [indicators, quotes] = await Promise.all([
        fetchAllIndicators(allAssets),
        fetchAllQuotes(allAssets),
      ]);

      const priceMap = new Map<string, { price: number }>();
      for (const [sym, q] of quotes.entries()) {
        priceMap.set(sym, { price: q.price });
      }

      const result = evaluateSignals(
        indicators,
        priceMap,
        stockAssets.map((a) => a.symbol),
        cryptoAssets.map((a) => a.symbol)
      );

      cache = { data: result, fetchedAt: Date.now() };
      console.log("[api/signals] Fetch cycle complete, result cached.");
      return cache;
    } finally {
      // Always clear the promise so the next cycle can start after TTL
      fetchPromise = null;
    }
  })();

  return fetchPromise;
}

// ─── Route handler ────────────────────────────────────────────────────────

export async function GET() {
  try {
    const { data } = await getSignals();
    const { agentResults, stats, activity } = data;
    return NextResponse.json({ agentResults, stats, activity });
  } catch (err) {
    console.error("[api/signals]", err);
    return NextResponse.json({ error: "Signal fetch failed" }, { status: 500 });
  }
}
