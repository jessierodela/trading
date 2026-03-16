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

    console.log("[api/market] fetching quotes for:", assets.map(a => a.symbol).join(", "));
    console.log("[api/market] POLYGON_API_KEY present:", !!process.env.POLYGON_API_KEY);

    const quotes = await fetchAllQuotes(assets);

    console.log("[api/market] quotes resolved:", quotes.size, "of", assets.length);
    quotes.forEach((q, symbol) => {
      console.log(`[api/market]  ${symbol}: price=${q.price} changePct=${q.changePct}`);
    });

    // Log which symbols fell back to static
    const missing = assets.filter(a => !quotes.has(a.symbol)).map(a => a.symbol);
    if (missing.length > 0) {
      console.warn("[api/market] falling back to static for:", missing.join(", "));
    }

    const result = WATCHLIST.map((asset) => {
      const q = quotes.get(asset.symbol);
      if (!q) return asset;
      return {
        ...asset,
        price:    formatPrice(q.price, asset.type),
        change:   formatChange(q.changePct),
        changeUp: q.changeUp,
      };
    });

    return NextResponse.json({ quotes: result });
  } catch (err) {
    console.error("[api/market] caught error:", err);
    return NextResponse.json({ quotes: WATCHLIST });
  }
}