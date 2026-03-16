/**
 * lib/polygon.ts
 * Fetches live price + % change using yahoo-finance2 (no API key required).
 *
 * Replaces the previous Polygon.io implementation.
 * The rest of the stack (route.ts, Sidebar.tsx) is unchanged.
 *
 * Crypto symbols must be passed as e.g. "BTC" — this file appends "-USD".
 */

import createYahooFinance from "yahoo-finance2/createYahooFinance";
import quote from "yahoo-finance2/modules/quote";

const YahooFinance = createYahooFinance({ modules: { quote } });
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

export interface PolygonQuote {
  symbol:    string;
  price:     number;
  change:    number;     // $ change
  changePct: number;     // % change (e.g. 2.34 means +2.34%)
  changeUp:  boolean;
}

export type AssetType = "stock" | "crypto";

// ─── Single quote ──────────────────────────────────────────────────────────

export async function fetchQuote(
  symbol: string,
  type: AssetType
): Promise<PolygonQuote | null> {
  try {
    // Yahoo uses "BTC-USD" for crypto, plain "AAPL" for stocks
    const ticker = type === "crypto" ? `${symbol}-USD` : symbol;

    const q = await yf.quote(ticker);

    const price = q.regularMarketPrice;
    const prevC = q.regularMarketPreviousClose;

    if (!price || !prevC) return null;

    const change    = price - prevC;
    const changePct = (change / prevC) * 100;

    return { symbol, price, change, changePct, changeUp: changePct >= 0 };
  } catch {
    return null;
  }
}

// ─── Batch fetch ───────────────────────────────────────────────────────────

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
