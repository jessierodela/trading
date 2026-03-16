/**
 * app/api/signals/route.ts
 * Fetches Taapi indicators for all assets, runs signal evaluation,
 * and returns agent results + stats + activity log.
 *
 * This route is intentionally NOT cached (Taapi is polled fresh each call)
 * but the client only calls it every 30s.
 *
 * GET /api/signals
 * Response: { agentResults, stats, activity }
 *
 * NOTE: On the free Taapi plan, this endpoint takes ~11s to resolve
 * (10 assets × 1.1s delay). The client should show a loading state.
 */

import { NextResponse } from "next/server";
import { fetchAllIndicators } from "@/lib/taapi";
import { fetchAllQuotes }     from "@/lib/polygon";
import { evaluateSignals }    from "@/lib/signals";
import { WATCHLIST }          from "@/config/assets";

// Don't cache this route — we want fresh signals every poll
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const stockAssets  = WATCHLIST.filter((a) => a.type === "stock");
    const cryptoAssets = WATCHLIST.filter((a) => a.type === "crypto");
    const allAssets    = WATCHLIST.map((a) => ({ symbol: a.symbol, type: a.type }));

    // Fetch indicators + quotes in parallel where possible
    // Taapi is sequential (rate limit), Polygon is parallel — run together
    const [indicators, quotes] = await Promise.all([
      fetchAllIndicators(allAssets),
      fetchAllQuotes(allAssets),
    ]);

    // Convert Polygon quotes to simple price map for signal engine
    const priceMap = new Map<string, { price: number }>();
    for (const [sym, q] of quotes.entries()) {
      priceMap.set(sym, { price: q.price });
    }

    const { agentResults, stats, activity } = evaluateSignals(
      indicators,
      priceMap,
      stockAssets.map((a) => a.symbol),
      cryptoAssets.map((a) => a.symbol)
    );

    return NextResponse.json({ agentResults, stats, activity });
  } catch (err) {
    console.error("[api/signals]", err);
    return NextResponse.json({ error: "Signal fetch failed" }, { status: 500 });
  }
}
