/**
 * lib/taapi.ts
 * Fetches technical indicator values from Taapi.io
 *
 * Free plan: 1 credit/sec. Each indicator in a bulk call = 1 credit.
 * We send 3 indicators per bulk call (3 credits) with a 4s delay between assets.
 * Two bulk calls per asset: [RSI, MACD, ATR] and [EMA50, EMA200, BB]
 *
 * Total per asset: 6 credits @ 1/sec = 6s minimum spacing → we use 7s to be safe.
 *
 * Supported indicators per agent:
 *   Momentum Scout     → RSI, MACD
 *   Breakout Watcher   → BB (Bollinger Bands), volume (from Polygon)
 *   Trend Follower     → EMA50, EMA200
 *   Crypto Ranger      → RSI, MACD (crypto exchange)
 *   Mean Reversion     → RSI (oversold)
 *   Volatility Arbiter → ATR
 */

const BASE = "https://api.taapi.io";
const KEY  = process.env.TAAPI_API_KEY!;

// Free plan: 1 credit/sec. 6 indicators per asset = 6 credits.
// Wait 7s between assets to stay safely under the limit.
const DELAY_BETWEEN_ASSETS_MS = 7000;

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
    { indicator: "rsi",    ...base },
    { indicator: "macd",   ...base },
    { indicator: "ema",    ...base, period: 50,  id: "ema50"  },
    { indicator: "ema",    ...base, period: 200, id: "ema200" },
    { indicator: "bbands", ...base },
    { indicator: "atr",    ...base },
  ];
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Fetch single asset via bulk endpoint ─────────────────────────────────

async function fetchBulk(
  symbol: string,
  exchange: Exchange,
  retries = 2
): Promise<IndicatorValues> {
  const empty: IndicatorValues = {
    symbol, rsi: null, macd: null, ema50: null, ema200: null, bb: null, atr: null,
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const body = {
        secret:    KEY,
        construct: buildBulkBody(symbol, exchange),
      };

      const res = await fetch(`${BASE}/bulk`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });

      if (res.status === 429) {
        const backoff = (attempt + 1) * 10_000; // 10s, 20s
        console.warn(`[taapi] ${symbol} rate limited (429), retrying in ${backoff / 1000}s...`);
        await sleep(backoff);
        continue;
      }

      if (!res.ok) {
        console.error(`[taapi] ${symbol} bulk failed: ${res.status}`);
        return empty;
      }

      const json = await res.json();
      const data: Array<{ id?: string; indicator: string; result: Record<string, number> }> =
        json.data ?? [];

      const get = (ind: string, id?: string) =>
        data.find((d) => (id ? d.id === id : d.indicator === ind))?.result ?? null;

      const rsiResult    = get("rsi");
      const macdResult   = get("macd");
      const ema50Result  = get("ema", "ema50");
      const ema200Result = get("ema", "ema200");
      const bbResult     = get("bbands");
      const atrResult    = get("atr");

      return {
        symbol,
        rsi:   rsiResult  ? rsiResult.value : null,
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
      console.error(`[taapi] ${symbol} error (attempt ${attempt + 1}):`, err);
      if (attempt < retries) await sleep(5000);
    }
  }

  return empty;
}

// ─── Public API ────────────────────────────────────────────────────────────

export type AssetType = "stock" | "crypto";

/**
 * Fetch indicators for all assets, respecting the free-tier rate limit.
 *
 * Free plan = 1 credit/sec. Each indicator in a bulk = 1 credit.
 * 6 indicators per asset → 7s delay between assets.
 *
 * 10 assets × 7s = ~70s total refresh cycle. This is expected on the free plan.
 * Consider reducing to fewer assets or upgrading to Basic ($29/mo) for faster polling.
 *
 * Stocks  → exchange: "stocks"
 * Crypto  → exchange: "binance", symbol like "BTC/USDT"
 */
export async function fetchAllIndicators(
  assets: { symbol: string; type: AssetType }[]
): Promise<Map<string, IndicatorValues>> {
  const map = new Map<string, IndicatorValues>();

  console.log(`[taapi] Starting fetch for ${assets.length} assets (~${Math.ceil(assets.length * DELAY_BETWEEN_ASSETS_MS / 1000)}s estimated)`);

  for (let i = 0; i < assets.length; i++) {
    const { symbol, type } = assets[i];

    const exchange: Exchange  = type === "crypto" ? "binance" : "stocks";
    const taapiSymbol         = type === "crypto" ? `${symbol}/USDT` : symbol;

    console.log(`[taapi] Fetching ${symbol} (${i + 1}/${assets.length})...`);
    const result = await fetchBulk(taapiSymbol, exchange);
    map.set(symbol, { ...result, symbol });

    // Always wait between assets — even after the last one to reset the rate limit
    // window before the next full poll cycle begins.
    if (i < assets.length - 1) {
      await sleep(DELAY_BETWEEN_ASSETS_MS);
    }
  }

  console.log(`[taapi] Fetch complete for ${assets.length} assets.`);
  return map;
}