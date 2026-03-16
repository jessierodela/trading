// app/api/quotes/route.ts
// Server-side only — yahoo-finance2 lives here, never in the browser bundle.

import { NextRequest, NextResponse } from "next/server";
import { fetchQuote, formatPrice, formatChange, type AssetType } from "@/lib/polygon";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const assetsParam = searchParams.get("assets");

  if (!assetsParam) {
    return NextResponse.json({ error: "assets param required" }, { status: 400 });
  }

  // e.g. "^GSPC:stock,BTC:crypto"
  const assets = assetsParam.split(",").map((entry) => {
    const [symbol, type] = entry.split(":");
    return { symbol, type: type as AssetType };
  });

  const quotes = await Promise.all(assets.map((a) => fetchQuote(a.symbol, a.type)));

  const result: Record<string, { price: string; change: string; up: boolean }> = {};
  assets.forEach((a, i) => {
    const q = quotes[i];
    if (!q) return;
    result[a.symbol] = {
      price:  formatPrice(q.price, a.type),
      change: formatChange(q.changePct),
      up:     q.changeUp,
    };
  });

  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
  });
}