/**
 * app/api/market/route.ts
 * Returns live price + % change for all watchlist assets.
 * Cached server-side for 30s to avoid hammering Polygon on every client poll.
 *
 * GET /api/market
 * Response: { quotes: WatchlistAsset[] }
 */

import { NextResponse } from "next/server";
import { fetchAllQuotes, formatPrice, formatChange } from "@/lib/polygon";
import { WATCHLIST } from "@/config/assets";

// Next.js route segment config — revalidate cache every 30s
export const revalidate = 30;

export async function GET() {
  try {
    const assets = WATCHLIST.map((a) => ({ symbol: a.symbol, type: a.type }));
    const quotes = await fetchAllQuotes(assets);

    const result = WATCHLIST.map((asset) => {
      const q = quotes.get(asset.symbol);
      if (!q) {
        // Fall back to static data if Polygon call failed
        return asset;
      }
      return {
        ...asset,
        price:    formatPrice(q.price, asset.type),
        change:   formatChange(q.changePct),
        changeUp: q.changeUp,
      };
    });

    return NextResponse.json({ quotes: result });
  } catch (err) {
    console.error("[api/market]", err);
    // Return static fallback so UI never breaks
    return NextResponse.json({ quotes: WATCHLIST });
  }
}
