/**
 * lib/taapi.ts
 * Fetches technical indicator values from Taapi.io
 *
 * Free plan: 1 indicator per call, 1 call/15sec.
 * Each indicator is fetched individually with a 15.5s gap between calls.
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
  bb:     { valueLowerBand: number; valueMiddleBand: number; valueUpperBand: number } | null;
  atr:    number | null;

  // ── Phase 2: previous-bar values (backtrack: 1) ────────────────────────
  // Used by Momentum Scout for bar-to-bar acceleration/deceleration logic.
  // Null when prev-bar fetch is skipped (e.g. free plan rate limits).
  prevRsi:      number | null;
  prevHist:     number | null; // previous MACD histogram value
  prevEma20:    number | null;
  currentClose: number | null; // current bar close price

  // ── Volume ─────────────────────────────────────────────────────────────
  // volume is overridden by yahoo-finance2 (regularMarketVolume) in indicatorCache.
  // prevVolume + volumeSma20 come from taapi (prev-bar candle + volumesma endpoint).
  // high/low come from taapi candle — used for candleRangeInAtr.
  volume:      number | null;
  prevVolume:  number | null;
  volumeSma20: number | null;
  high:        number | null; // current bar high
  low:         number | null; // current bar low
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
    ema200: null, bb: null, atr: null,
    // Phase 2 prev-bar fields
    prevRsi: null, prevHist: null, prevEma20: null, currentClose: null,
    // Volume + candle range
    volume: null, prevVolume: null, volumeSma20: null, high: null, low: null,
  };
}

// ─── Single indicator fetch ───────────────────────────────────────────────

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

// ─── Fetch all enabled indicators for one asset ───────────────────────────

const INDICATOR_DELAY_MS = 15500; // free plan: 1 req / 15 sec

async function fetchAssetIndicators(
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
        // taapi endpoint: "volumesma" — 20-bar average volume.
        // Used by indicatorCache to compute relativeVolume and volumeAboveAverage.
        const r = await fetchIndicator("volumesma", symbol, exchange, { period: 20 });
        result.volumeSma20 = r?.value ?? null;
        break;
      }
      case "candle": {
        // Fetches current-bar OHLCV — used for high/low (candleRangeInAtr)
        // and provides prevVolume when combined with backtrack: 1 below.
        const r = await fetchIndicator("candle", symbol, exchange);
        result.high = r?.high ?? null;
        result.low  = r?.low  ?? null;
        // volume from candle is a fallback only; yahoo-finance2 overrides it in cache
        if (result.volume == null) result.volume = r?.volume ?? null;
        break;
      }
    }

    if (i < enabled.length - 1) {
      await sleep(INDICATOR_DELAY_MS);
    }
  }

  // ── Phase 2: fetch prev-bar values for Momentum Scout ─────────────────
  // Only fetch if the base indicators we need were successfully retrieved.
  // Each prev-bar call costs one rate-limited slot (15.5s on free plan).
  if (result.rsi !== null && enabled.includes("rsi")) {
    await sleep(INDICATOR_DELAY_MS);
    console.log(`[taapi] ${symbol} — fetching rsi (prev bar)`);
    const r = await fetchIndicator("rsi", symbol, exchange, { period: 14, backtrack: 1 });
    result.prevRsi = r?.value ?? null;
  }

  if (result.macd !== null && enabled.includes("macd")) {
    await sleep(INDICATOR_DELAY_MS);
    console.log(`[taapi] ${symbol} — fetching macd histogram (prev bar)`);
    const r = await fetchIndicator("macd", symbol, exchange, { backtrack: 1 });
    result.prevHist = r?.valueMACDHist ?? null;
  }

  if (result.ema20 !== null && enabled.includes("ema20")) {
    await sleep(INDICATOR_DELAY_MS);
    console.log(`[taapi] ${symbol} — fetching ema20 (prev bar)`);
    const r = await fetchIndicator("ema", symbol, exchange, { period: 20, backtrack: 1 });
    result.prevEma20 = r?.value ?? null;
  }

  // Fetch current close price (used for % distance from EMA20)
  // Uses the /price endpoint — 1 call, returns { value: number }
  if (enabled.includes("ema20")) {
    await sleep(INDICATOR_DELAY_MS);
    console.log(`[taapi] ${symbol} — fetching current close`);
    const r = await fetchIndicator("price", symbol, exchange);
    result.currentClose = r?.value ?? null;
  }

  // ── Volume: previous-bar volume via candle backtrack ──────────────────
  // Only fetch if "candle" was enabled (provides high/low/volume for current bar).
  // prevVolume = previous bar's volume, used to compute volumeChangePct + volumeExpanding.
  if (enabled.includes("candle")) {
    await sleep(INDICATOR_DELAY_MS);
    console.log(`[taapi] ${symbol} — fetching candle (prev bar) for prevVolume`);
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

    console.log(`[taapi] Fetching ${symbol} (${i + 1}/${activeAssets.length}) — [${enabled.join(", ")}]`);

    const result = await fetchAssetIndicators(taapiSymbol, exchange, enabled);
    map.set(symbol, { ...result, symbol });

    if (i < activeAssets.length - 1) {
      await sleep(2000);
    }
  }

  console.log(`[taapi] Fetch complete.`);
  return map;
}
