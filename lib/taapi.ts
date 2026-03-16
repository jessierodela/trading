/**
 * lib/taapi.ts
 * Fetches technical indicator values from Taapi.io
 *
 * Free plan: 1 credit/sec. Each indicator in a bulk call = 1 credit.
 * Delay between assets = (number of indicators for that asset + 1) seconds.
 *
 * Indicator selection is DYNAMIC — driven by config/indicators.ts.
 * Only enabled indicators are fetched, saving credits and reducing cycle time.
 */

import {
  type AssetIndicatorConfig,
  type IndicatorKey,
  DEFAULT_INDICATOR_CONFIG,
  getEnabledIndicators,
  estimateCycleSeconds,
} from "@/config/indicators";

const BASE = "https://api.taapi.io";
const KEY  = process.env.TAAPI_API_KEY!;

// ─── Types ────────────────────────────────────────────────────────────────

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

interface BulkConstructItem {
  indicator: string;
  exchange?: string;
  symbol:    string;
  interval:  string;
  id?:       string;
  period?:   number;
  [key: string]: unknown;
}

// ─── Bulk query builder (dynamic) ─────────────────────────────────────────

function buildBulkBody(
  symbol:   string,
  exchange: Exchange,
  enabled:  IndicatorKey[]
): BulkConstructItem[] {
  const base = { exchange, symbol, interval: "1h" };
  const items: BulkConstructItem[] = [];

  for (const key of enabled) {
    switch (key) {
      case "rsi":   items.push({ indicator: "rsi",    ...base }); break;
      case "macd":  items.push({ indicator: "macd",   ...base }); break;
      case "ema50": items.push({ indicator: "ema",    ...base, period: 50,  id: "ema50"  }); break;
      case "ema200":items.push({ indicator: "ema",    ...base, period: 200, id: "ema200" }); break;
      case "bb":    items.push({ indicator: "bbands", ...base }); break;
      case "atr":   items.push({ indicator: "atr",    ...base }); break;
    }
  }

  return items;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function emptyResult(symbol: string): IndicatorValues {
  return { symbol, rsi: null, macd: null, ema50: null, ema200: null, bb: null, atr: null };
}

// ─── Fetch single asset ────────────────────────────────────────────────────

async function fetchBulk(
  symbol:   string,
  exchange: Exchange,
  enabled:  IndicatorKey[],
  retries = 2
): Promise<IndicatorValues> {
  if (enabled.length === 0) {
    console.warn(`[taapi] ${symbol} has no enabled indicators — skipping.`);
    return emptyResult(symbol);
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const body = {
        secret:    KEY,
        construct: buildBulkBody(symbol, exchange, enabled),
      };

      // DEBUG — remove once BTC is confirmed working
      console.log(`[taapi] ${symbol} request body:`, JSON.stringify(body, null, 2));

      const res = await fetch(`${BASE}/bulk`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });

      if (res.status === 429) {
        const backoff = (attempt + 1) * 10_000;
        console.warn(`[taapi] ${symbol} rate limited (429), retrying in ${backoff / 1000}s...`);
        await sleep(backoff);
        continue;
      }

      if (!res.ok) {
        // DEBUG — log the actual error body from TAAPI, not just the status code
        const errText = await res.text();
        console.error(`[taapi] ${symbol} bulk failed: ${res.status} — ${errText}`);
        return emptyResult(symbol);
      }

      const json = await res.json();
      const data: Array<{ id?: string; indicator: string; result: Record<string, number> }> =
        json.data ?? [];

      const get = (ind: string, id?: string) =>
        data.find((d) => (id ? d.id === id : d.indicator === ind))?.result ?? null;

      return {
        symbol,
        rsi:   get("rsi")   ? get("rsi")!.value   : null,
        macd:  get("macd")  ? {
          valueMACD:       get("macd")!.valueMACD,
          valueMACDSignal: get("macd")!.valueMACDSignal,
          valueMACDHist:   get("macd")!.valueMACDHist,
        } : null,
        ema50:  get("ema", "ema50")  ? get("ema", "ema50")!.value  : null,
        ema200: get("ema", "ema200") ? get("ema", "ema200")!.value : null,
        bb:    get("bbands") ? {
          valueLowerBand:  get("bbands")!.valueLowerBand,
          valueMiddleBand: get("bbands")!.valueMiddleBand,
          valueUpperBand:  get("bbands")!.valueUpperBand,
        } : null,
        atr:   get("atr") ? get("atr")!.value : null,
      };

    } catch (err) {
      console.error(`[taapi] ${symbol} error (attempt ${attempt + 1}):`, err);
      if (attempt < retries) await sleep(5000);
    }
  }
  return emptyResult(symbol);
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Fetch indicators for all assets using the provided (or default) indicator config.
 *
 * Rate limiting: delay after each asset = (indicators_for_that_asset + 1) seconds.
 * More efficient than a fixed 7s delay — assets with fewer indicators wait less.
 *
 * Pass a custom indicatorConfig (loaded from DB/API) to use user-configured indicators.
 */
export async function fetchAllIndicators(
  assets:          { symbol: string; type: AssetType }[],
  indicatorConfig: AssetIndicatorConfig[] = DEFAULT_INDICATOR_CONFIG
): Promise<Map<string, IndicatorValues>> {
  const map       = new Map<string, IndicatorValues>();
  const estimated = estimateCycleSeconds(indicatorConfig);

  console.log(`[taapi] Starting fetch for ${assets.length} assets (~${estimated}s estimated)`);

  for (let i = 0; i < assets.length; i++) {
    const { symbol, type } = assets[i];

    const exchange:    Exchange       = type === "crypto" ? "binance" : "stocks";
    const taapiSymbol: string         = type === "crypto" ? `${symbol}/USDT` : symbol;
    const enabled:     IndicatorKey[] = getEnabledIndicators(symbol, indicatorConfig);

    console.log(`[taapi] Fetching ${symbol} (${i + 1}/${assets.length}) — [${enabled.join(", ")}]`);

    const result = await fetchBulk(taapiSymbol, exchange, enabled);
    map.set(symbol, { ...result, symbol });

    if (i < assets.length - 1) {
      const delay = (enabled.length + 1) * 1000;
      await sleep(delay);
    }
  }

  console.log(`[taapi] Fetch complete.`);
  return map;
}
