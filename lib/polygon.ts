/**
 * lib/polygon.ts
 * Fetches live price + % change data from Polygon.io
 * Stocks  → /v2/snapshot/locale/us/markets/stocks/tickers/{symbol}
 * Crypto  → /v2/snapshot/locale/global/markets/crypto/tickers/X:{symbol}USD
 */

const BASE = "https://api.polygon.io";
const KEY  = process.env.POLYGON_API_KEY!;

export interface PolygonQuote {
  symbol:   string;
  price:    number;
  change:   number;   // $ change
  changePct: number;  // % change (e.g. 2.34 means +2.34%)
  changeUp: boolean;
}

// ─── Stocks ────────────────────────────────────────────────────────────────

async function fetchStockQuote(symbol: string): Promise<PolygonQuote | null> {
  try {
    const res = await fetch(
      `${BASE}/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}?apiKey=${KEY}`,
      { next: { revalidate: 30 } }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const day  = json?.ticker?.day;
    const prev = json?.ticker?.prevDay;
    if (!day || !prev) return null;

    const price    = day.c;                          // close price
    const change   = price - prev.c;
    const changePct = (change / prev.c) * 100;

    return {
      symbol,
      price,
      change,
      changePct,
      changeUp: changePct >= 0,
    };
  } catch {
    return null;
  }
}

// ─── Crypto ────────────────────────────────────────────────────────────────

async function fetchCryptoQuote(symbol: string): Promise<PolygonQuote | null> {
  try {
    // Polygon crypto tickers use "X:BTCUSD" format
    const ticker = `X:${symbol}USD`;
    const res = await fetch(
      `${BASE}/v2/snapshot/locale/global/markets/crypto/tickers/${ticker}?apiKey=${KEY}`,
      { next: { revalidate: 30 } }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const day  = json?.ticker?.day;
    const prev = json?.ticker?.prevDay;
    if (!day || !prev) return null;

    const price    = day.c;
    const change   = price - prev.c;
    const changePct = (change / prev.c) * 100;

    return {
      symbol,
      price,
      change,
      changePct,
      changeUp: changePct >= 0,
    };
  } catch {
    return null;
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

export type AssetType = "stock" | "crypto";

export async function fetchQuote(
  symbol: string,
  type: AssetType
): Promise<PolygonQuote | null> {
  return type === "crypto"
    ? fetchCryptoQuote(symbol)
    : fetchStockQuote(symbol);
}

/** Fetch all quotes in parallel (Polygon has no strict per-second limit on free). */
export async function fetchAllQuotes(
  assets: { symbol: string; type: AssetType }[]
): Promise<Map<string, PolygonQuote>> {
  const results = await Promise.all(
    assets.map((a) => fetchQuote(a.symbol, a.type))
  );
  const map = new Map<string, PolygonQuote>();
  results.forEach((q) => {
    if (q) map.set(q.symbol, q);
  });
  return map;
}

// ─── Formatters ────────────────────────────────────────────────────────────

export function formatPrice(price: number, type: AssetType): string {
  if (type === "crypto") {
    if (price >= 1000) return `$${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    return `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatChange(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}
