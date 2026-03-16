/**
 * lib/taapi.ts
 * Fetches technical indicator values from Taapi.io
 *
 * Free plan: ~1 req/sec — we queue requests with a 1.1s delay between assets.
 * We use the /bulk endpoint to pack multiple indicators into a single call per asset.
 *
 * Supported indicators per agent:
 *   Momentum Scout   → RSI, MACD
 *   Breakout Watcher → BB (Bollinger Bands), volume (from Polygon)
 *   Trend Follower   → EMA50, EMA200
 *   Crypto Ranger    → RSI, MACD (crypto exchange)
 *   Mean Reversion   → RSI (oversold)
 *   Volatility Arbiter → ATR
 */

const BASE = "https://api.taapi.io";
const KEY  = process.env.TAAPI_API_KEY!;

export interface IndicatorValues {
  symbol:    string;
  rsi:       number | null;
  macd:      { valueMACD: number; valueMACDSignal: number; valueMACDHist: number } | null;
  ema50:     number | null;
  ema200:    number | null;
  bb:        { valueLowerBand: number; valueMiddleBand: number; valueUpperBand: number } | null;
  atr:       number | null;
}

// ─── Bulk query builder ────────────────────────────────────────────────────

type Exchange = "binance" | "stocks";

interface BulkConstructItem {
  indicator: string;
  exchange?: string;
  symbol:    string;
  interval:  string;
  [key: string]: unknown;
}

function buildBulkBody(symbol: string, exchange: Exchange): BulkConstructItem[] {
  const base = { exchange, symbol, interval: "1h" };
  return [
    { indicator: "rsi",  ...base },
    { indicator: "macd", ...base },
    { indicator: "ema",  ...base, period: 50,  id: "ema50"  },
    { indicator: "ema",  ...base, period: 200, id: "ema200" },
    { indicator: "bbands", ...base },
    { indicator: "atr",  ...base },
  ];
}

// ─── Rate-limit queue (1.1s between calls) ────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Fetch single asset via bulk endpoint ─────────────────────────────────

async function fetchBulk(
  symbol: string,
  exchange: Exchange
): Promise<IndicatorValues> {
  const empty: IndicatorValues = {
    symbol, rsi: null, macd: null, ema50: null, ema200: null, bb: null, atr: null,
  };

  try {
    const body = {
      secret:    KEY,
      construct: buildBulkBody(symbol, exchange),
    };

    const res = await fetch(`${BASE}/bulk`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      // Don't cache — we want fresh data every 30s poll
    });

    if (!res.ok) {
      console.error(`[taapi] ${symbol} bulk failed: ${res.status}`);
      return empty;
    }

    const json = await res.json();
    // json.data is an array matching the construct order
    const data: Array<{ id?: string; indicator: string; result: Record<string, number> }> =
      json.data ?? [];

    const get = (ind: string, id?: string) =>
      data.find((d) => (id ? d.id === id : d.indicator === ind))?.result ?? null;

    const rsiResult  = get("rsi");
    const macdResult = get("macd");
    const ema50Result  = get("ema", "ema50");
    const ema200Result = get("ema", "ema200");
    const bbResult   = get("bbands");
    const atrResult  = get("atr");

    return {
      symbol,
      rsi:   rsiResult  ? rsiResult.value          : null,
      macd:  macdResult ? {
        valueMACD:       macdResult.valueMACD,
        valueMACDSignal: macdResult.valueMACDSignal,
        valueMACDHist:   macdResult.valueMACDHist,
      } : null,
      ema50:  ema50Result  ? ema50Result.value  : null,
      ema200: ema200Result ? ema200Result.value : null,
      bb:    bbResult ? {
        valueLowerBand:  bbResult.valueLowerBand,
        valueMiddleBand: bbResult.valueMiddleBand,
        valueUpperBand:  bbResult.valueUpperBand,
      } : null,
      atr:   atrResult ? atrResult.value : null,
    };
  } catch (err) {
    console.error(`[taapi] ${symbol} error:`, err);
    return empty;
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

export type AssetType = "stock" | "crypto";

/**
 * Fetch indicators for all assets, respecting the 1 req/sec free-tier limit.
 * Stocks  → exchange: "stocks" (Taapi supports US stocks)
 * Crypto  → exchange: "binance", symbol like "BTC/USDT"
 */
export async function fetchAllIndicators(
  assets: { symbol: string; type: AssetType }[]
): Promise<Map<string, IndicatorValues>> {
  const map = new Map<string, IndicatorValues>();

  for (let i = 0; i < assets.length; i++) {
    const { symbol, type } = assets[i];

    const exchange: Exchange = type === "crypto" ? "binance" : "stocks";
    // Taapi crypto symbols use "BTC/USDT" format
    const taapiSymbol = type === "crypto" ? `${symbol}/USDT` : symbol;

    const result = await fetchBulk(taapiSymbol, exchange);
    // Store under original symbol key
    map.set(symbol, { ...result, symbol });

    // Rate-limit: wait 1.1s between requests (free tier = 1 req/sec)
    if (i < assets.length - 1) {
      await sleep(1100);
    }
  }

  return map;
}
