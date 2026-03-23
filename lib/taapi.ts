/**
 * lib/taapi.ts
 * Fetches technical indicator values from Taapi.io
 *
 * Strategy:
 *   - Crypto assets on Binance → POST /bulk (up to 20 calculations per request,
 *     1 request / 15s). All current-bar indicators in one call; all prev-bar
 *     (backtrack:1) indicators in a second call. Total: 2 rate-limit slots
 *     instead of ~13.
 *   - Stock assets → sequential GET (unchanged, stocks exchange does not
 *     support the bulk endpoint on the free plan).
 *
 * Free plan constraints:
 *   - 1 API request / 15 seconds
 *   - Bulk: up to 20 constructs per POST
 *   - Binance real-time pairs only: BTC/USDT, ETH/USDT, XRP/USD, LTC/USDT, XMR/USDT
 *     (SOL is NOT available on the free plan — keep it disabled in indicators config)
 */

import {
  type AssetIndicatorConfig,
  type IndicatorKey,
  DEFAULT_INDICATOR_CONFIG,
  getEnabledIndicators,
} from "@/config/indicators";

const BASE = "https://api.taapi.io";
const KEY  = process.env.TAAPI_API_KEY!;

export interface IndicatorValues {
  symbol: string;
  rsi:    number | null;
  macd:   { valueMACD: number; valueMACDSignal: number; valueMACDHist: number } | null;
  ema20:  number | null;
  ema50:  number | null;
  ema200: number | null;
  bb:           { valueLowerBand: number; valueMiddleBand: number; valueUpperBand: number } | null;
  bb_width:     number | null; // (upper - lower) / middle — derived after fetch
  bb_width_prev: number | null; // same calc from prev-bar BB values
  atr:          number | null;

  // ── Phase 2: previous-bar values (backtrack: 1) ───────────────────────
  prevRsi:      number | null;
  prevHist:     number | null;
  prevEma20:    number | null;
  prevEma50:    number | null;
  prevEma200:   number | null;
  currentClose: number | null;

  // ── Volume + candle range ─────────────────────────────────────────────
  // volume is overridden by yahoo-finance2 in indicatorCache.
  volume:      number | null;
  prevVolume:  number | null;
  volumeSma20: number | null;
  high:        number | null;
  low:         number | null;
}

export type AssetType = "stock" | "crypto";
type Exchange = "binance" | "stocks";

// ─── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function emptyResult(symbol: string): IndicatorValues {
  return {
    symbol, rsi: null, macd: null, ema20: null, ema50: null,
    ema200: null, bb: null, bb_width: null, bb_width_prev: null, atr: null,
    prevRsi: null, prevHist: null, prevEma20: null, prevEma50: null, prevEma200: null,
    currentClose: null, volume: null, prevVolume: null, volumeSma20: null, high: null, low: null,
  };
}

// ─── Sequential GET (stocks / fallback) ──────────────────────────────────

async function fetchIndicator(
  indicator: string,
  symbol:    string,
  exchange:  Exchange,
  params:    Record<string, unknown> = {},
  retries = 2
): Promise<Record<string, number> | null> {
  const url = new URL(`${BASE}/${indicator}`);
  url.searchParams.set("secret",   KEY);
  url.searchParams.set("exchange", exchange);
  url.searchParams.set("symbol",   symbol);
  url.searchParams.set("interval", "1h");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url.toString());

      if (res.status === 429) {
        const backoff = (attempt + 1) * 15_000;
        console.warn(`[taapi] ${symbol}/${indicator} rate limited, retrying in ${backoff / 1000}s...`);
        await sleep(backoff);
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[taapi] ${symbol}/${indicator} failed: ${res.status} — ${errText}`);
        return null;
      }

      return await res.json();

    } catch (err) {
      console.error(`[taapi] ${symbol}/${indicator} error (attempt ${attempt + 1}):`, err);
      if (attempt < retries) await sleep(5000);
    }
  }

  return null;
}

// ─── Bulk POST (crypto / Binance) ─────────────────────────────────────────

// Internal construct shape — params are kept separate for clarity when building
// the list, then flattened before sending to taapi (which expects them at the
// top level of each indicator object, not nested under a "params" key).
interface BulkConstruct {
  id:        string;
  indicator: string;
  params?:   Record<string, unknown>;
}

// Wire shape taapi actually expects: { id, indicator, period?, backtrack?, ... }
type BulkConstructWire = { id: string; indicator: string } & Record<string, unknown>;

// Raw item shape returned by taapi's /bulk endpoint.
// `result` is a free-form object whose keys depend on the indicator
// (e.g. { value } for RSI, { valueMACD, valueMACDSignal, valueMACDHist } for MACD).
interface BulkResultItem {
  id:     string;
  result: Record<string, number>;
  errors?: string[];
}

/**
 * POST /bulk — fetches up to 20 indicator constructs in a single rate-limit slot.
 * Returns a map of { [id]: result } for easy lookup, or null on failure.
 */
async function fetchBulk(
  symbol:     string,
  exchange:   Exchange,
  constructs: BulkConstruct[],
  retries = 2
): Promise<Map<string, Record<string, number>> | null> {
  // Flatten params into each construct — taapi expects { id, indicator, period, backtrack, ... }
  // not { id, indicator, params: { period, backtrack } }
  const wire: BulkConstructWire[] = constructs.map(({ id, indicator, params }) => ({
    id,
    indicator,
    ...params,
  }));

  const body = {
    secret: KEY,
    construct: {
      exchange,
      symbol,
      interval: "1h",
      indicators: wire,
    },
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${BASE}/bulk`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });

      if (res.status === 429) {
        const backoff = (attempt + 1) * 15_000;
        console.warn(`[taapi] ${symbol}/bulk rate limited, retrying in ${backoff / 1000}s...`);
        await sleep(backoff);
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[taapi] ${symbol}/bulk failed: ${res.status} — ${errText}`);
        return null;
      }

      const json = await res.json() as { data: BulkResultItem[] };

      const map = new Map<string, Record<string, number>>();
      for (const item of json.data) {
        if (item.errors?.length) {
          console.warn(`[taapi] bulk item "${item.id}" had errors:`, item.errors);
          continue; // skip failed constructs; others still populate the map
        }
        map.set(item.id, item.result);
      }

      return map;

    } catch (err) {
      console.error(`[taapi] ${symbol}/bulk error (attempt ${attempt + 1}):`, err);
      if (attempt < retries) await sleep(5000);
    }
  }

  return null;
}

// ─── Crypto bulk fetch ────────────────────────────────────────────────────

const INDICATOR_DELAY_MS = 15500;

/**
 * Fetches all enabled indicators for a crypto asset using two bulk POSTs:
 *   1. Current-bar indicators (RSI, MACD, EMA20, EMA50, EMA200, BB, ATR,
 *      volumeSma20, candle, price)
 *   2. Prev-bar indicators (RSI backtrack:1, MACD backtrack:1, EMA20 backtrack:1,
 *      candle backtrack:1 for prevVolume)
 *
 * Each POST counts as one rate-limit slot (15s). Two calls = ~31s total,
 * versus ~200s for the equivalent sequential fetch.
 */
async function fetchCryptoIndicatorsBulk(
  symbol:   string,   // e.g. "BTC/USDT"
  exchange: Exchange,
  enabled:  IndicatorKey[]
): Promise<IndicatorValues> {
  const result = emptyResult(symbol);

  // ── Build current-bar construct list ────────────────────────────────
  const currentConstructs: BulkConstruct[] = [];

  if (enabled.includes("rsi"))       currentConstructs.push({ id: "rsi",       indicator: "rsi" });
  if (enabled.includes("macd"))      currentConstructs.push({ id: "macd",      indicator: "macd" });
  if (enabled.includes("ema20"))     currentConstructs.push({ id: "ema20",     indicator: "ema",       params: { period: 20 } });
  if (enabled.includes("ema50"))     currentConstructs.push({ id: "ema50",     indicator: "ema",       params: { period: 50 } });
  if (enabled.includes("ema200"))    currentConstructs.push({ id: "ema200",    indicator: "ema",       params: { period: 200 } });
  if (enabled.includes("bb"))        currentConstructs.push({ id: "bb",        indicator: "bbands" });
  if (enabled.includes("atr"))       currentConstructs.push({ id: "atr",       indicator: "atr" });
  // taapi does not have a "volumesma" endpoint. Use "vwma" (Volume Weighted Moving Average)
  // as the closest proxy for a volume-smoothed average, or swap for "obv" / "volume" if preferred.
  if (enabled.includes("volumeSma20")) currentConstructs.push({ id: "volsma",  indicator: "vwma", params: { period: 20 } });
  if (enabled.includes("candle"))    currentConstructs.push({ id: "candle",    indicator: "candle" });
  // currentClose via price endpoint
  if (enabled.includes("ema20"))     currentConstructs.push({ id: "price",     indicator: "price" });

  // ── Build prev-bar construct list ───────────────────────────────────
  const prevConstructs: BulkConstruct[] = [];

  if (enabled.includes("rsi"))    prevConstructs.push({ id: "prevRsi",    indicator: "rsi",    params: { backtrack: 1 } });
  if (enabled.includes("macd"))   prevConstructs.push({ id: "prevMacd",   indicator: "macd",   params: { backtrack: 1 } });
  if (enabled.includes("ema20"))  prevConstructs.push({ id: "prevEma20",  indicator: "ema",    params: { period: 20,  backtrack: 1 } });
  if (enabled.includes("ema50"))  prevConstructs.push({ id: "prevEma50",  indicator: "ema",    params: { period: 50,  backtrack: 1 } });
  if (enabled.includes("ema200")) prevConstructs.push({ id: "prevEma200", indicator: "ema",    params: { period: 200, backtrack: 1 } });
  if (enabled.includes("bb"))     prevConstructs.push({ id: "prevBb",     indicator: "bbands", params: { backtrack: 1 } });
  if (enabled.includes("candle")) prevConstructs.push({ id: "prevCandle", indicator: "candle", params: { backtrack: 1 } });

  // ── Call 1: current-bar bulk ─────────────────────────────────────────
  if (currentConstructs.length > 0) {
    console.log(`[taapi] ${symbol} — bulk current-bar (${currentConstructs.length} constructs)`);
    const current = await fetchBulk(symbol, exchange, currentConstructs);

    if (current) {
      result.rsi   = current.get("rsi")?.value   ?? null;
      result.ema20 = current.get("ema20")?.value  ?? null;
      result.ema50 = current.get("ema50")?.value  ?? null;
      result.ema200 = current.get("ema200")?.value ?? null;
      result.atr   = current.get("atr")?.value   ?? null;
      result.volumeSma20 = current.get("volsma")?.value ?? null;
      result.currentClose = current.get("price")?.value ?? null;

      const m = current.get("macd");
      if (m) {
        result.macd = {
          valueMACD:       m.valueMACD,
          valueMACDSignal: m.valueMACDSignal,
          valueMACDHist:   m.valueMACDHist,
        };
      }

      const bb = current.get("bb");
      if (bb) {
        result.bb = {
          valueLowerBand:  bb.valueLowerBand,
          valueMiddleBand: bb.valueMiddleBand,
          valueUpperBand:  bb.valueUpperBand,
        };
        // bb_width = (upper - lower) / middle — normalised band width
        if (bb.valueMiddleBand > 0) {
          result.bb_width = (bb.valueUpperBand - bb.valueLowerBand) / bb.valueMiddleBand;
        }
      }

      const candle = current.get("candle");
      if (candle) {
        result.high = candle.high ?? null;
        result.low  = candle.low  ?? null;
        if (result.volume == null) result.volume = candle.volume ?? null;
      }
    } else {
      console.warn(`[taapi] ${symbol} — current-bar bulk returned null, result will be empty`);
    }
  }

  // ── Call 2: prev-bar bulk ────────────────────────────────────────────
  if (prevConstructs.length > 0) {
    await sleep(INDICATOR_DELAY_MS); // honour 1 req / 15s rate limit

    console.log(`[taapi] ${symbol} — bulk prev-bar (${prevConstructs.length} constructs)`);
    const prev = await fetchBulk(symbol, exchange, prevConstructs);

    if (prev) {
      result.prevRsi    = prev.get("prevRsi")?.value          ?? null;
      result.prevHist   = prev.get("prevMacd")?.valueMACDHist  ?? null;
      result.prevEma20  = prev.get("prevEma20")?.value         ?? null;
      result.prevEma50  = prev.get("prevEma50")?.value         ?? null;
      result.prevEma200 = prev.get("prevEma200")?.value        ?? null;
      result.prevVolume = prev.get("prevCandle")?.volume       ?? null;

      const prevBb = prev.get("prevBb");
      if (prevBb && prevBb.valueMiddleBand > 0) {
        result.bb_width_prev = (prevBb.valueUpperBand - prevBb.valueLowerBand) / prevBb.valueMiddleBand;
      }
    } else {
      console.warn(`[taapi] ${symbol} — prev-bar bulk returned null, prev values will be null`);
    }
  }

  return result;
}

// ─── Sequential fetch (stocks, unchanged) ────────────────────────────────

async function fetchAssetIndicatorsSequential(
  symbol:   string,
  exchange: Exchange,
  enabled:  IndicatorKey[]
): Promise<IndicatorValues> {
  const result = emptyResult(symbol);

  for (let i = 0; i < enabled.length; i++) {
    const key = enabled[i];
    console.log(`[taapi] ${symbol} — fetching ${key} (${i + 1}/${enabled.length})`);

    switch (key) {
      case "rsi": {
        const r = await fetchIndicator("rsi", symbol, exchange);
        result.rsi = r?.value ?? null;
        break;
      }
      case "macd": {
        const r = await fetchIndicator("macd", symbol, exchange);
        result.macd = r
          ? { valueMACD: r.valueMACD, valueMACDSignal: r.valueMACDSignal, valueMACDHist: r.valueMACDHist }
          : null;
        break;
      }
      case "ema20": {
        const r = await fetchIndicator("ema", symbol, exchange, { period: 20 });
        result.ema20 = r?.value ?? null;
        break;
      }
      case "ema50": {
        const r = await fetchIndicator("ema", symbol, exchange, { period: 50 });
        result.ema50 = r?.value ?? null;
        break;
      }
      case "ema200": {
        const r = await fetchIndicator("ema", symbol, exchange, { period: 200 });
        result.ema200 = r?.value ?? null;
        break;
      }
      case "bb": {
        const r = await fetchIndicator("bbands", symbol, exchange);
        result.bb = r
          ? { valueLowerBand: r.valueLowerBand, valueMiddleBand: r.valueMiddleBand, valueUpperBand: r.valueUpperBand }
          : null;
        break;
      }
      case "atr": {
        const r = await fetchIndicator("atr", symbol, exchange);
        result.atr = r?.value ?? null;
        break;
      }
      case "volumeSma20": {
        // taapi has no "volumesma" endpoint — "vwma" (Volume Weighted Moving Average)
        // is the closest available proxy for a smoothed volume average.
        const r = await fetchIndicator("vwma", symbol, exchange, { period: 20 });
        result.volumeSma20 = r?.value ?? null;
        break;
      }
      case "candle": {
        const r = await fetchIndicator("candle", symbol, exchange);
        result.high = r?.high ?? null;
        result.low  = r?.low  ?? null;
        if (result.volume == null) result.volume = r?.volume ?? null;
        break;
      }
    }

    if (i < enabled.length - 1) await sleep(INDICATOR_DELAY_MS);
  }

  // prev-bar sequential (same as before)
  if (result.rsi !== null && enabled.includes("rsi")) {
    await sleep(INDICATOR_DELAY_MS);
    const r = await fetchIndicator("rsi", symbol, exchange, { period: 14, backtrack: 1 });
    result.prevRsi = r?.value ?? null;
  }
  if (result.macd !== null && enabled.includes("macd")) {
    await sleep(INDICATOR_DELAY_MS);
    const r = await fetchIndicator("macd", symbol, exchange, { backtrack: 1 });
    result.prevHist = r?.valueMACDHist ?? null;
  }
  if (result.ema20 !== null && enabled.includes("ema20")) {
    await sleep(INDICATOR_DELAY_MS);
    const r = await fetchIndicator("ema", symbol, exchange, { period: 20, backtrack: 1 });
    result.prevEma20 = r?.value ?? null;
  }
  if (enabled.includes("ema20")) {
    await sleep(INDICATOR_DELAY_MS);
    const r = await fetchIndicator("price", symbol, exchange);
    result.currentClose = r?.value ?? null;
  }
  if (enabled.includes("candle")) {
    await sleep(INDICATOR_DELAY_MS);
    const r = await fetchIndicator("candle", symbol, exchange, { backtrack: 1 });
    result.prevVolume = r?.volume ?? null;
  }

  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────

export async function fetchAllIndicators(
  assets:          { symbol: string; type: AssetType }[],
  indicatorConfig: AssetIndicatorConfig[] = DEFAULT_INDICATOR_CONFIG
): Promise<Map<string, IndicatorValues>> {
  const map = new Map<string, IndicatorValues>();

  const activeAssets = assets.filter(({ symbol }) =>
    getEnabledIndicators(symbol, indicatorConfig).length > 0
  );

  console.log(
    `[taapi] ${activeAssets.length} active asset(s) of ${assets.length}. ` +
    `Active: [${activeAssets.map((a) => a.symbol).join(", ")}]`
  );

  for (let i = 0; i < activeAssets.length; i++) {
    const { symbol, type } = activeAssets[i];

    const exchange:    Exchange       = type === "crypto" ? "binance" : "stocks";
    const taapiSymbol: string         = type === "crypto" ? `${symbol}/USDT` : symbol;
    const enabled:     IndicatorKey[] = getEnabledIndicators(symbol, indicatorConfig);

    console.log(`[taapi] Fetching ${symbol} (${i + 1}/${activeAssets.length}) — [${enabled.join(", ")}] — strategy: ${type === "crypto" ? "bulk" : "sequential"}`);

    // Crypto → bulk POST (2 calls total: current-bar + prev-bar)
    // Stocks → sequential GET (unchanged behaviour)
    const result = type === "crypto"
      ? await fetchCryptoIndicatorsBulk(taapiSymbol, exchange, enabled)
      : await fetchAssetIndicatorsSequential(taapiSymbol, exchange, enabled);

    map.set(symbol, { ...result, symbol });

    if (i < activeAssets.length - 1) {
      await sleep(2000);
    }
  }

  console.log(`[taapi] Fetch complete.`);
  return map;
}
