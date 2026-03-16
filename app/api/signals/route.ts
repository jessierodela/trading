/**
 * app/api/signals/route.ts
 * Poll interval controlled by config/polling.ts — SIGNALS_CACHE_TTL_MS.
 */

import { NextResponse }          from "next/server";
import { fetchAllIndicators }    from "@/lib/taapi";
import { fetchAllQuotes }        from "@/lib/polygon";
import { evaluateSignals }       from "@/lib/signals";
import { WATCHLIST }             from "@/config/assets";
import { SIGNALS_CACHE_TTL_MS }  from "@/config/polling";

export const dynamic = "force-dynamic";

// ─── Cache + mutex ────────────────────────────────────────────────────────

interface CachedResult {
  data:      ReturnType<typeof evaluateSignals>;
  fetchedAt: number;
}

let cache:        CachedResult | null = null;
let fetchPromise: Promise<CachedResult> | null = null;

async function getSignals(): Promise<CachedResult> {
  if (cache && Date.now() - cache.fetchedAt < SIGNALS_CACHE_TTL_MS) {
    console.log(`[api/signals] Cache hit (age: ${Math.round((Date.now() - cache.fetchedAt) / 1000)}s)`);
    return cache;
  }

  if (fetchPromise) {
    console.log("[api/signals] Fetch in progress — waiting for existing cycle...");
    return fetchPromise;
  }

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
      console.log(`[api/signals] Fetch complete. Next cycle in ${SIGNALS_CACHE_TTL_MS / 1000}s.`);
      return cache;
    } finally {
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