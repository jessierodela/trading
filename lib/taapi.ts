/**
 * lib/taapi.ts
 * Fetches technical indicator values from Taapi.io
 *
 * Free plan: 1 indicator per call, 1 call/sec.
 * We call each indicator individually with a 1.1s gap between calls.
 * Bulk endpoint is NOT available on the free plan.
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
  ema50:  number | null;
  ema200: number | null;
  bb:     { valueLowerBand: number; valueMiddleBand: number; valueUpperBand: number } | null;
  atr:    number | null;
}

export type AssetType = "stock" | "crypto";
type Exchange = "binance" | "stocks";

// ─── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function emptyResult(symbol: string): IndicatorValues {
  return { symbol, rsi: null, macd: null, ema50: null, ema200: null, bb: null, atr: null };
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

// 1.1s between each indicator call to stay within 1 req/sec free plan limit
const INDICATOR_DELAY_MS = 15500; //free plan: 1 req / 15 sec

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
    }

    // Wait between indicator calls — but not after the last one
    if (i < enabled.length - 1) {
      await sleep(INDICATOR_DELAY_MS);
    }
  }

  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Fetch indicators for all active assets sequentially.
 *
 * Free plan = 1 call/sec. Each indicator = 1 call.
 * Assets with no enabled indicators are skipped instantly.
 *
 * BTC with [rsi, macd, atr] = 3 calls, ~3.3s total.
 */
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

    // Extra 2s gap between assets to let the rate limit window reset
    if (i < activeAssets.length - 1) {
      await sleep(2000);
    }
  }

  console.log(`[taapi] Fetch complete.`);
  return map;
}
