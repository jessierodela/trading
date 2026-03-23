/**
 * lib/taapi1d.ts
 *
 * Fetches daily (1D) indicator values from taapi.io.
 * Mirrors the architecture of taapi.ts but with interval: "1d".
 *
 * Scoped to what Trend Follower needs: ema50, ema200, candle (for daily close).
 * Uses the same bulk POST strategy for crypto (Binance) — 2 calls total:
 *   Call 1: current-bar — ema50, ema200, candle, price
 *   Call 2: prev-bar    — prevEma50, prevEma200 (backtrack: 1)
 *
 * Daily bars update once per day. The cache TTL is 24h.
 * Manual refresh via POST /api/cache/refresh re-fetches immediately.
 *
 * Re-uses IndicatorValues from taapi.ts — same shape, different interval.
 * Fields not fetched on 1D (rsi, macd, atr, etc.) will remain null.
 */

import {
  type AssetIndicatorConfig,
  type IndicatorKey,
  getEnabledIndicators,
} from "@/config/indicators";
import { type IndicatorValues } from "@/lib/taapi";

const BASE = "https://api.taapi.io";
const KEY  = process.env.TAAPI_API_KEY!;
const INTERVAL = "1d";

export type AssetType = "stock" | "crypto";
type Exchange = "binance" | "stocks";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function emptyResult(symbol: string): IndicatorValues {
  return {
    symbol, rsi: null, macd: null, ema20: null, ema50: null,
    ema200: null, bb: null, bb_width: null, bb_width_prev: null, atr: null,
    prevRsi: null, prevHist: null, prevEma20: null, prevEma50: null, prevEma200: null,
    currentClose: null, volume: null, prevVolume: null, volumeSma20: null,
    high: null, low: null, open: null, atrAvg20: null,
  };
}

// ─── Bulk POST ────────────────────────────────────────────────────────────────

interface BulkConstruct {
  id:        string;
  indicator: string;
  params?:   Record<string, unknown>;
}

type BulkConstructWire = { id: string; indicator: string } & Record<string, unknown>;

interface BulkResultItem {
  id:      string;
  result:  Record<string, number>;
  errors?: string[];
}

const INDICATOR_DELAY_MS = 15500;

async function fetchBulk(
  symbol:     string,
  exchange:   Exchange,
  constructs: BulkConstruct[],
  retries = 2
): Promise<Map<string, Record<string, number>> | null> {
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
      interval: INTERVAL,
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
        console.warn(`[taapi1d] ${symbol}/bulk rate limited, retrying in ${backoff / 1000}s...`);
        await sleep(backoff);
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[taapi1d] ${symbol}/bulk failed: ${res.status} — ${errText}`);
        return null;
      }

      const json = await res.json() as { data: BulkResultItem[] };
      const map  = new Map<string, Record<string, number>>();

      for (const item of json.data) {
        if (item.errors?.length) {
          console.warn(`[taapi1d] bulk item "${item.id}" had errors:`, item.errors);
          continue;
        }
        map.set(item.id, item.result);
      }

      return map;

    } catch (err) {
      console.error(`[taapi1d] ${symbol}/bulk error (attempt ${attempt + 1}):`, err);
      if (attempt < retries) await sleep(5000);
    }
  }

  return null;
}

// ─── Sequential GET (stocks / fallback) ──────────────────────────────────────

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
  url.searchParams.set("interval", INTERVAL);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url.toString());

      if (res.status === 429) {
        const backoff = (attempt + 1) * 15_000;
        console.warn(`[taapi1d] ${symbol}/${indicator} rate limited, retrying in ${backoff / 1000}s...`);
        await sleep(backoff);
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[taapi1d] ${symbol}/${indicator} failed: ${res.status} — ${errText}`);
        return null;
      }

      return await res.json();

    } catch (err) {
      console.error(`[taapi1d] ${symbol}/${indicator} error (attempt ${attempt + 1}):`, err);
      if (attempt < retries) await sleep(5000);
    }
  }

  return null;
}

// ─── Crypto bulk fetch (1D) ───────────────────────────────────────────────────

/**
 * Fetches 1D indicators for a crypto asset using two bulk POSTs:
 *   Call 1: current-bar — ema50, ema200, candle (open/high/low/volume), price
 *   Call 2: prev-bar    — prevEma50, prevEma200 (backtrack: 1)
 *
 * Only fetches what's enabled in the 1D config — unused constructs are skipped.
 */
async function fetchCryptoIndicators1dBulk(
  symbol:   string,
  exchange: Exchange,
  enabled:  IndicatorKey[]
): Promise<IndicatorValues> {
  const result = emptyResult(symbol);

  // ── Current-bar constructs ─────────────────────────────────────────────
  const currentConstructs: BulkConstruct[] = [];

  if (enabled.includes("ema50"))  currentConstructs.push({ id: "ema50",  indicator: "ema", params: { period: 50 } });
  if (enabled.includes("ema200")) currentConstructs.push({ id: "ema200", indicator: "ema", params: { period: 200 } });
  if (enabled.includes("candle")) currentConstructs.push({ id: "candle", indicator: "candle" });
  if (enabled.includes("candle") || enabled.includes("ema50")) {
    // Always fetch price for currentClose — needed for price-vs-EMA location
    currentConstructs.push({ id: "price", indicator: "price" });
  }

  // ── Prev-bar constructs ────────────────────────────────────────────────
  const prevConstructs: BulkConstruct[] = [];

  if (enabled.includes("ema50"))  prevConstructs.push({ id: "prevEma50",  indicator: "ema", params: { period: 50,  backtrack: 1 } });
  if (enabled.includes("ema200")) prevConstructs.push({ id: "prevEma200", indicator: "ema", params: { period: 200, backtrack: 1 } });

  // ── Call 1: current-bar ────────────────────────────────────────────────
  if (currentConstructs.length > 0) {
    console.log(`[taapi1d] ${symbol} — bulk current-bar 1D (${currentConstructs.length} constructs)`);
    const current = await fetchBulk(symbol, exchange, currentConstructs);

    if (current) {
      result.ema50        = current.get("ema50")?.value  ?? null;
      result.ema200       = current.get("ema200")?.value ?? null;
      result.currentClose = current.get("price")?.value  ?? null;

      const candle = current.get("candle");
      if (candle) {
        result.open   = candle.open   ?? null;
        result.high   = candle.high   ?? null;
        result.low    = candle.low    ?? null;
        result.volume = candle.volume ?? null;
        // Use candle close as currentClose if price endpoint unavailable
        if (result.currentClose == null) result.currentClose = candle.close ?? null;
      }
    } else {
      console.warn(`[taapi1d] ${symbol} — current-bar 1D bulk returned null`);
    }
  }

  // ── Call 2: prev-bar ───────────────────────────────────────────────────
  if (prevConstructs.length > 0) {
    await sleep(INDICATOR_DELAY_MS);

    console.log(`[taapi1d] ${symbol} — bulk prev-bar 1D (${prevConstructs.length} constructs)`);
    const prev = await fetchBulk(symbol, exchange, prevConstructs);

    if (prev) {
      result.prevEma50  = prev.get("prevEma50")?.value  ?? null;
      result.prevEma200 = prev.get("prevEma200")?.value ?? null;
    } else {
      console.warn(`[taapi1d] ${symbol} — prev-bar 1D bulk returned null`);
    }
  }

  return result;
}

// ─── Sequential fetch (stocks) ────────────────────────────────────────────────

async function fetchAssetIndicators1dSequential(
  symbol:   string,
  exchange: Exchange,
  enabled:  IndicatorKey[]
): Promise<IndicatorValues> {
  const result = emptyResult(symbol);
  const items  = enabled.filter((k) => ["ema50", "ema200", "candle"].includes(k));

  for (let i = 0; i < items.length; i++) {
    const key = items[i];

    switch (key) {
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
      case "candle": {
        const r = await fetchIndicator("candle", symbol, exchange);
        result.open   = r?.open   ?? null;
        result.high   = r?.high   ?? null;
        result.low    = r?.low    ?? null;
        result.volume = r?.volume ?? null;
        break;
      }
    }

    if (i < items.length - 1) await sleep(INDICATOR_DELAY_MS);
  }

  // prev-bar
  if (enabled.includes("ema50")) {
    await sleep(INDICATOR_DELAY_MS);
    const r = await fetchIndicator("ema", symbol, exchange, { period: 50, backtrack: 1 });
    result.prevEma50 = r?.value ?? null;
  }
  if (enabled.includes("ema200")) {
    await sleep(INDICATOR_DELAY_MS);
    const r = await fetchIndicator("ema", symbol, exchange, { period: 200, backtrack: 1 });
    result.prevEma200 = r?.value ?? null;
  }
  // currentClose via price endpoint
  if (enabled.includes("ema50") || enabled.includes("candle")) {
    await sleep(INDICATOR_DELAY_MS);
    const r = await fetchIndicator("price", symbol, exchange);
    result.currentClose = r?.value ?? null;
  }

  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch all 1D indicators for active assets.
 * Called by indicatorCache1d.ts — never called directly by agents.
 */
export async function fetchAllIndicators1d(
  assets:          { symbol: string; type: AssetType }[],
  indicatorConfig: AssetIndicatorConfig[]
): Promise<Map<string, IndicatorValues>> {
  const map = new Map<string, IndicatorValues>();

  const activeAssets = assets.filter(({ symbol }) =>
    getEnabledIndicators(symbol, indicatorConfig).length > 0
  );

  console.log(
    `[taapi1d] ${activeAssets.length} active asset(s). ` +
    `Active: [${activeAssets.map((a) => a.symbol).join(", ")}]`
  );

  for (let i = 0; i < activeAssets.length; i++) {
    const { symbol, type } = activeAssets[i];

    const exchange:    Exchange       = type === "crypto" ? "binance" : "stocks";
    const taapiSymbol: string         = type === "crypto" ? `${symbol}/USDT` : symbol;
    const enabled:     IndicatorKey[] = getEnabledIndicators(symbol, indicatorConfig);

    console.log(`[taapi1d] Fetching ${symbol} 1D (${i + 1}/${activeAssets.length}) — [${enabled.join(", ")}]`);

    const result = type === "crypto"
      ? await fetchCryptoIndicators1dBulk(taapiSymbol, exchange, enabled)
      : await fetchAssetIndicators1dSequential(taapiSymbol, exchange, enabled);

    map.set(symbol, { ...result, symbol });

    if (i < activeAssets.length - 1) await sleep(2000);
  }

  console.log(`[taapi1d] 1D fetch complete.`);
  return map;
}
