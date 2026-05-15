/**
 * lib/data/coinbaseRest.ts
 *
 * Coinbase Exchange REST client for historical OHLCV candles.
 *
 * Endpoint: GET https://api.exchange.coinbase.com/products/{symbol}/candles
 *
 * Public market data — no auth, no API key. The architecture decision in
 * ARCHITECTURE.md §2 picked Coinbase Exchange as the canonical BTC venue
 * because it's free, US-regulated, and the WebSocket path (future) gives
 * sub-second bar-close latency.
 *
 * ─── Response shape ───────────────────────────────────────────────────────
 * The API returns tuples in [time, low, high, open, close, volume] order.
 * Note this is NOT OHLC — it's L/H/O/C. Easy to swap by accident; the
 * mapping function below is the only place this matters.
 *
 * Returned in DESCENDING order (newest first). We reverse to ascending
 * because every consumer downstream (bar store, feature engine, backtests)
 * expects ascending and there's no reason to make them all reverse.
 *
 * ─── Granularity ──────────────────────────────────────────────────────────
 * Coinbase accepts these granularities (seconds): 60, 300, 900, 3600,
 * 21600, 86400. We map our Timeframe union onto the supported subset.
 * 5m/15m/1h/1d are direct; 1m is direct. There is no native 4h or 30m on
 * this endpoint — those would require local rollup.
 *
 * ─── Window limits ────────────────────────────────────────────────────────
 * Max 300 candles per request. If (end - start) / granularity > 300 the
 * request is REJECTED, not truncated. fetchCandleWindow() enforces this;
 * fetchCandlesRange() paginates above it.
 *
 * ─── Rate limits ──────────────────────────────────────────────────────────
 * Coinbase public endpoints are softly rate-limited — there's no published
 * exact ceiling, but ~10 req/s sustained is fine. We default to a 200ms
 * inter-request gap which puts us at 5 req/s. Tunable via opts if a future
 * caller needs to be faster (or slower).
 *
 * ─── What this module does NOT do ─────────────────────────────────────────
 * - Auth (none needed for /candles)
 * - Retries / backoff (caller's responsibility — see route)
 * - Rate-limit header parsing (Coinbase doesn't expose useful ones here)
 * - WebSocket (separate module when we wire live ingestion)
 */

import type { Bar, Timeframe, Exchange } from "@/lib/quant/types";

// ─── Constants ────────────────────────────────────────────────────────────

const BASE_URL  = "https://api.exchange.coinbase.com";
const EXCHANGE: Exchange = "COINBASE";

/** Coinbase's per-request candle ceiling. Documented, enforced server-side. */
export const MAX_CANDLES_PER_REQUEST = 300;

/**
 * Timeframe → granularity (seconds) map. Only timeframes Coinbase supports
 * natively. 5m/15m/1h/1d available; everything else needs local rollup.
 */
const TIMEFRAME_SECONDS: Record<Timeframe, number | null> = {
  "1m":  60,
  "5m":  300,
  "15m": 900,
  "1h":  3_600,
  "1d":  86_400,
};

// ─── Errors ───────────────────────────────────────────────────────────────

export class CoinbaseRestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(`[coinbase-rest] ${message}`);
    this.name = "CoinbaseRestError";
  }
}

// ─── Types ────────────────────────────────────────────────────────────────

/** Raw Coinbase candle tuple: [time_sec, low, high, open, close, volume]. */
type RawCandle = [number, number, number, number, number, number];

export interface FetchCandlesOpts {
  /** Inter-request delay for paginated calls. Default 200ms. */
  requestGapMs?: number;
  /** Fetch implementation (for tests). Default global fetch. */
  fetchImpl?: typeof fetch;
  /** AbortSignal so the caller can cancel a long-running paginated fetch. */
  signal?: AbortSignal;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const id = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

function granularityFor(timeframe: Timeframe): number {
  const s = TIMEFRAME_SECONDS[timeframe];
  if (s === null) {
    throw new CoinbaseRestError(`timeframe ${timeframe} is not supported by Coinbase REST candles`);
  }
  return s;
}

/**
 * Convert raw [t,l,h,o,c,v] tuple → Bar. The column order trap lives here
 * and nowhere else.
 */
function rawToBar(raw: RawCandle, symbol: string, timeframe: Timeframe): Bar {
  const [tSec, low, high, open, close, volume] = raw;
  return {
    symbol,
    exchange:  EXCHANGE,
    timeframe,
    ts:        new Date(tSec * 1000).toISOString(),
    open,
    high,
    low,
    close,
    volume:    volume,
    tradeCount: null,
  };
}

// ─── Single-window fetch ──────────────────────────────────────────────────

/**
 * Fetch one window of candles. The window MUST fit inside Coinbase's
 * 300-candle cap; the caller is responsible for sizing.
 *
 * Returns ascending bars (oldest first).
 *
 * Throws CoinbaseRestError on non-2xx response or malformed body.
 */
export async function fetchCandleWindow(
  symbol:    string,
  timeframe: Timeframe,
  startTs:   string,
  endTs:     string,
  opts:      FetchCandlesOpts = {},
): Promise<Bar[]> {
  const granularity = granularityFor(timeframe);

  // Belt-and-suspenders: bail before Coinbase rejects us.
  const startMs = Date.parse(startTs);
  const endMs   = Date.parse(endTs);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new CoinbaseRestError(`invalid start/end timestamp: ${startTs} / ${endTs}`);
  }
  if (startMs >= endMs) {
    throw new CoinbaseRestError(`startTs must be < endTs (got ${startTs} / ${endTs})`);
  }
  const expectedCandles = Math.ceil((endMs - startMs) / 1000 / granularity);
  if (expectedCandles > MAX_CANDLES_PER_REQUEST) {
    throw new CoinbaseRestError(
      `window [${startTs}, ${endTs}) at ${timeframe} = ${expectedCandles} candles, ` +
      `exceeds Coinbase max of ${MAX_CANDLES_PER_REQUEST}. Use fetchCandlesRange() for paginated fetches.`
    );
  }

  const url = new URL(`${BASE_URL}/products/${symbol}/candles`);
  url.searchParams.set("granularity", String(granularity));
  url.searchParams.set("start",       startTs);
  url.searchParams.set("end",         endTs);

  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn(url, { signal: opts.signal });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CoinbaseRestError(
      `GET ${url.pathname}${url.search} → ${res.status}`,
      res.status,
      body.slice(0, 500),
    );
  }

  const raw = await res.json() as unknown;
  if (!Array.isArray(raw)) {
    throw new CoinbaseRestError(`expected array, got ${typeof raw}`);
  }

  // Validate EVERY tuple. Cost is negligible at ≤300 rows per request, and
  // a partial-API-drift response (some tuples shaped right, some not) would
  // otherwise reach rawToBar() and produce silently-malformed bars.
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (!Array.isArray(t) || t.length !== 6 || !t.every((v) => typeof v === "number" && Number.isFinite(v))) {
      throw new CoinbaseRestError(
        `expected [time, low, high, open, close, volume] tuple of 6 finite numbers at index ${i}; ` +
        `got ${JSON.stringify(t).slice(0, 100)}`
      );
    }
  }

  const tuples = raw as RawCandle[];

  // Coinbase can include the end-boundary candle. Internally, our desk treats
  // candle ranges as half-open: [startTs, endTs). Enforce that here so callers
  // never accidentally store an in-progress or duplicate boundary candle.
  return tuples
    .map((r) => rawToBar(r, symbol, timeframe))
    .filter((b) => {
      const tsMs = Date.parse(b.ts);
      return tsMs >= startMs && tsMs < endMs;
    })
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

// ─── Paginated fetch ──────────────────────────────────────────────────────

/**
 * Fetch a range of candles spanning more than 300 bars by walking forward
 * in 300-candle windows.
 *
 * Returns ascending bars (oldest first), deduplicated across window
 * boundaries.
 *
 * If you pass an AbortSignal in opts, mid-paginate cancellation throws and
 * partial results are discarded (use fetchCandleWindow in a loop yourself
 * if you want partial-result behavior).
 */
export async function fetchCandlesRange(
  symbol:    string,
  timeframe: Timeframe,
  startTs:   string,
  endTs:     string,
  opts:      FetchCandlesOpts = {},
): Promise<Bar[]> {
  const granularity   = granularityFor(timeframe);
  const granularityMs = granularity * 1_000;
  const windowMs      = MAX_CANDLES_PER_REQUEST * granularityMs;
  const gapMs         = opts.requestGapMs ?? 200;

  const startMs = Date.parse(startTs);
  const endMs   = Date.parse(endTs);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new CoinbaseRestError(`invalid start/end timestamp: ${startTs} / ${endTs}`);
  }
  if (startMs >= endMs) return [];

  const all: Bar[] = [];
  let cursor = startMs;
  let isFirst = true;

  while (cursor < endMs) {
    if (!isFirst) await sleep(gapMs, opts.signal);
    isFirst = false;

    const windowEnd = Math.min(cursor + windowMs, endMs);
    const bars = await fetchCandleWindow(
      symbol,
      timeframe,
      new Date(cursor).toISOString(),
      new Date(windowEnd).toISOString(),
      opts,
    );
    all.push(...bars);
    cursor = windowEnd;
  }

  // Dedup defensively — Coinbase has been known to include the boundary bar
  // in adjacent windows. Keep first occurrence (they're identical anyway).
  const seen = new Set<string>();
  const deduped: Bar[] = [];
  for (const b of all) {
    if (seen.has(b.ts)) continue;
    seen.add(b.ts);
    deduped.push(b);
  }
  return deduped;
}