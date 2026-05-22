/**
 * scripts/backfillCryptoBulk.ts
 *
 * Generic, multi-symbol crypto OHLCV backfill straight from Coinbase Exchange
 * public REST candles — no deployed route, no auth, no API key. Generalizes
 * the BTC-only bootstrap so the P6 multi-asset research set (ETH/SOL/LINK/AVAX,
 * etc.) can be ingested locally.
 *
 * For each symbol it fetches 1h candles for the configured lookback, rolls them
 * up to 1d locally (one API path, half the requests), and inserts both
 * timeframes with onConflict=ignore so re-running is safe.
 *
 * Usage:
 *   SYMBOLS=BTC-USD,ETH-USD,SOL-USD,LINK-USD,AVAX-USD \
 *   EXCHANGE=COINBASE \
 *   YEARS=2 \
 *   npm run backfill:crypto:bulk
 *
 * Env vars:
 *   SYMBOLS       — comma-separated Coinbase product ids. Default the P6 crypto set.
 *   EXCHANGE      — venue label stored on bars. Default COINBASE.
 *   YEARS         — lookback in years. Default 2.
 *   REQUEST_GAP_MS — inter-request delay for the paginated fetch. Default 200.
 *
 * Honest behavior: a symbol Coinbase does not list (or that has no candles in
 * the window) is reported and skipped; it does not abort the other symbols.
 */

import { fetchCandlesRange, CoinbaseRestError } from "@/lib/data/coinbaseRest";
import { rollupBars } from "@/lib/data/rollup";
import { getPgPool, PgBarStore } from "@/lib/storage";
import { closePgPool } from "@/lib/storage/clients";
import { DATA_SOURCE_COINBASE_REST } from "@/lib/versions";
import type { Bar, Exchange } from "@/lib/quant/types";

const DEFAULT_SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD", "LINK-USD", "AVAX-USD"];

// PgBarStore.insertMany builds a single multi-row INSERT (11 params/bar). Postgres
// caps a query at 65535 bind params, so we chunk well under that ceiling.
const INSERT_CHUNK_BARS = 1000;

async function insertChunked(
  barStore: PgBarStore,
  bars: Bar[],
  dataSourceVersion: string,
): Promise<number> {
  let inserted = 0;
  for (let offset = 0; offset < bars.length; offset += INSERT_CHUNK_BARS) {
    const chunk = bars.slice(offset, offset + INSERT_CHUNK_BARS);
    inserted += await barStore.insertMany(chunk, dataSourceVersion, { onConflict: "ignore" });
  }
  return inserted;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function parseSymbols(): string[] {
  return (process.env.SYMBOLS ?? DEFAULT_SYMBOLS.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

interface BackfillResult {
  symbol: string;
  status: "ok" | "no_data" | "error";
  bars1h: number;
  inserted1h: number;
  bars1d: number;
  inserted1d: number;
  note?: string;
}

async function backfillSymbol(
  symbol: string,
  exchange: Exchange,
  startTs: string,
  endTs: string,
  requestGapMs: number,
): Promise<BackfillResult> {
  const pool = getPgPool();
  const barStore = new PgBarStore(pool);
  try {
    const bars1h = await fetchCandlesRange(symbol, "1h", startTs, endTs, { requestGapMs });
    if (bars1h.length === 0) {
      return { symbol, status: "no_data", bars1h: 0, inserted1h: 0, bars1d: 0, inserted1d: 0, note: "Coinbase returned no candles in window" };
    }
    // Coinbase fetcher tags bars with EXCHANGE=COINBASE; override the label if the
    // caller configured a different exchange string so storage stays consistent.
    const relabelled = exchange === "COINBASE" ? bars1h : bars1h.map((b) => ({ ...b, exchange }));
    const bars1d = rollupBars(relabelled, "1d", { requireFullPeriod: true });
    const inserted1h = await insertChunked(barStore, relabelled, DATA_SOURCE_COINBASE_REST);
    const inserted1d = await insertChunked(barStore, bars1d, DATA_SOURCE_COINBASE_REST);
    return { symbol, status: "ok", bars1h: relabelled.length, inserted1h, bars1d: bars1d.length, inserted1d };
  } catch (err) {
    const note = err instanceof CoinbaseRestError
      ? `${err.message}${err.status ? ` (status ${err.status})` : ""}`
      : err instanceof Error ? err.message : String(err);
    return { symbol, status: "error", bars1h: 0, inserted1h: 0, bars1d: 0, inserted1d: 0, note };
  }
}

async function main(): Promise<void> {
  const symbols = parseSymbols();
  const exchange = (process.env.EXCHANGE ?? "COINBASE") as Exchange;
  const years = envNumber("YEARS", 2);
  const requestGapMs = envNumber("REQUEST_GAP_MS", 200);

  const now = new Date();
  const endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);
  const startMs = endMs - years * 365 * 24 * 60 * 60 * 1000;
  const startTs = new Date(startMs).toISOString();
  const endTs = new Date(endMs).toISOString();

  console.log(`[backfill:crypto:bulk] ${symbols.length} symbol(s), ${years}y, ${exchange}`);
  console.log(`[backfill:crypto:bulk] range ${startTs} → ${endTs}`);

  const results: BackfillResult[] = [];
  for (const symbol of symbols) {
    process.stdout.write(`[backfill:crypto:bulk] ${symbol} ... `);
    const result = await backfillSymbol(symbol, exchange, startTs, endTs, requestGapMs);
    results.push(result);
    if (result.status === "ok") {
      console.log(`1h bars=${result.bars1h} ins=${result.inserted1h}; 1d bars=${result.bars1d} ins=${result.inserted1d}`);
    } else {
      console.log(`${result.status}: ${result.note ?? ""}`);
    }
  }

  console.log("\n[backfill:crypto:bulk] summary:");
  for (const r of results) {
    console.log(`  ${r.symbol}: ${r.status} (1h ins=${r.inserted1h}, 1d ins=${r.inserted1d})${r.note ? ` — ${r.note}` : ""}`);
  }
  const failed = results.filter((r) => r.status === "error");
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("[backfill:crypto:bulk] failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePgPool().catch(() => undefined);
  });
