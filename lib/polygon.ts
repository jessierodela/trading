/**
 * lib/polygon.ts
 * Fetches live price + % change data from Polygon.io
 * Stocks  → /v2/snapshot/locale/us/markets/stocks/tickers/{symbol}
 * Crypto  → /v2/snapshot/locale/global/markets/crypto/tickers/X:{symbol}USD
 *
 * PRICE PRIORITY:
 *   1. lastTrade.p  — most recent trade (works outside market hours too)
 *   2. day.c        — today's close (only valid after market close)
 *   3. prevDay.c    — yesterday's close (final fallback)
 */

const BASE = "https://api.polygon.io";
const KEY  = process.env.POLYGON_API_KEY!;

export interface PolygonQuote {
  symbol:    string;
  price:     number;
  change:    number;    // $ change
  changePct: number;    // % change (e.g. 2.34 means +2.34%)
  changeUp:  boolean;
}

/** Pick the best available price from a Polygon snapshot ticker object. */
function resolvePrice(ticker: any): number | null {
  const last  = ticker?.lastTrade?.p;   // last trade price ← most reliable
  const dayC  = ticker?.day?.c;         // today's close (0 when market open/pre-market)
  const prevC = ticker?.prevDay?.c;     // yesterday's close

  // lastTrade.p is the most current; fall back only if it's missing or 0
  if (last  && last  > 0) return last;
  if (dayC  && dayC  > 0) return dayC;
  if (prevC && prevC > 0) return prevC;
  return null;
}

// ─── Stocks ────────────────────────────────────────────────────────────────

async function fetchStockQuote(symbol: string): Promise<PolygonQuote | null> {
  try {
    const res = await fetch(
      `${BASE}/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}?apiKey=${KEY}`,
      { next: { revalidate: 30 } }
    );
    if (!res.ok) return null;

    const json   = await res.json();
    const ticker = json?.ticker;
    if (!ticker) return null;

    const price  = resolvePrice(ticker);
    const prevC  = ticker?.prevDay?.c;
    if (!price || !prevC) return null;

    const change    = price - prevC;
    const changePct = (change / prevC) * 100;

    return { symbol, price, change, changePct, changeUp: changePct >= 0 };
  } catch {
    return null;
  }
}

// ─── Crypto ────────────────────────────────────────────────────────────────

async function fetchCryptoQuote(symbol: string): Promise<PolygonQuote | null> {
  try {
    const ticker = `X:${symbol}USD`;
    const res = await fetch(
      `${BASE}/v2/snapshot/locale/global/markets/crypto/tickers/${ticker}?apiKey=${KEY}`,
      { next: { revalidate: 30 } }
    );
    if (!res.ok) return null;

    const json       = await res.json();
    const tickerData = json?.ticker;
    if (!tickerData) return null;

    const price  = resolvePrice(tickerData);
    const prevC  = tickerData?.prevDay?.c;
    if (!price || !prevC) return null;

    const change    = price - prevC;
    const changePct = (change / prevC) * 100;

    return { symbol, price, change, changePct, changeUp: changePct >= 0 };
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

/** Fetch all quotes in parallel */
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
    if (price >= 1_000)
      return `$${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    return `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatChange(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}