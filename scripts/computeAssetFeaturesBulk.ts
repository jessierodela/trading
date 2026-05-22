/**
 * scripts/computeAssetFeaturesBulk.ts
 *
 * Asset-driven generalization of computeBtcFeaturesBulk.ts. Computes and persists
 * feature snapshots for every symbol in SYMBOLS across 1h and 1d timeframes.
 * No hardcoded BTC — drive it with SYMBOLS / EXCHANGE.
 *
 * Usage:
 *   SYMBOLS=BTC-USD,ETH-USD,SOL-USD,LINK-USD,AVAX-USD \
 *   EXCHANGE=COINBASE \
 *   npm run features:asset:bulk
 */

import { computeFeaturesSegmented } from "@/lib/features/engine";
import { getPgPool, PgBarStore, PgFeatureStore } from "@/lib/storage";
import { closePgPool } from "@/lib/storage/clients";
import { FEATURE_VERSION } from "@/lib/versions";
import { insertFeatureSnapshotsBulk } from "./bulkFeaturePersistence";
import type { Exchange, Timeframe } from "@/lib/quant/types";

const DEFAULT_SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD", "LINK-USD", "AVAX-USD"];
const TIMEFRAMES: Timeframe[] = ["1h", "1d"];

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

async function boundsFor(symbol: string, exchange: Exchange, timeframe: Timeframe): Promise<{ startTs: string; endTs: string } | null> {
  const pool = getPgPool();
  const { rows } = await pool.query<{ min_ts: Date | null; max_ts: Date | null }>(
    `select min(ts) as min_ts, max(ts) as max_ts
     from market_bars
     where symbol = $1 and exchange = $2 and timeframe = $3`,
    [symbol, exchange, timeframe],
  );
  const row = rows[0];
  if (!row?.min_ts || !row.max_ts) return null;
  const stepMs = timeframe === "1d" ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  return {
    startTs: row.min_ts.toISOString(),
    endTs: new Date(row.max_ts.getTime() + stepMs).toISOString(),
  };
}

async function countFeatures(symbol: string, exchange: Exchange, timeframe: Timeframe): Promise<number> {
  const pool = getPgPool();
  const { rows } = await pool.query<{ count: string }>(
    `select count(*)::text as count
     from feature_snapshots
     where symbol = $1 and exchange = $2 and timeframe = $3 and feature_version = $4`,
    [symbol, exchange, timeframe, FEATURE_VERSION],
  );
  return Number(rows[0]?.count ?? 0);
}

async function computeFor(symbol: string, exchange: Exchange, timeframe: Timeframe, chunkSize: number): Promise<void> {
  const bounds = await boundsFor(symbol, exchange, timeframe);
  if (!bounds) {
    console.log(`[features:asset:bulk] ${symbol} ${timeframe}: no bars found — skipped`);
    return;
  }

  const pool = getPgPool();
  const barStore = new PgBarStore(pool);
  const featureStore = new PgFeatureStore(pool);
  const bars = await barStore.fetchRange({ symbol, exchange, timeframe }, bounds);
  const result = computeFeaturesSegmented(bars);
  const inserted = await insertFeatureSnapshotsBulk(pool, result.rows, chunkSize);
  const totalFeatures = await countFeatures(symbol, exchange, timeframe);
  const latest = await featureStore.fetchLatest({ symbol, exchange, timeframe, featureVersion: FEATURE_VERSION });

  console.log(
    `[features:asset:bulk] ${symbol} ${timeframe}: bars=${bars.length} computed=${result.rows.length} ` +
    `inserted=${inserted} totalFeatures=${totalFeatures} latest=${latest?.ts ?? "none"} ` +
    `segments=${result.segments.length} gaps=${result.gapCount}`,
  );
}

async function main(): Promise<void> {
  const symbols = parseSymbols();
  const exchange = (process.env.EXCHANGE ?? "COINBASE") as Exchange;
  const chunkSize = envNumber("FEATURE_INSERT_CHUNK", 500);
  console.log(`[features:asset:bulk] ${symbols.length} symbol(s), exchange=${exchange}`);
  for (const symbol of symbols) {
    for (const timeframe of TIMEFRAMES) {
      await computeFor(symbol, exchange, timeframe, chunkSize);
    }
  }
}

main()
  .catch((err) => {
    console.error("[features:asset:bulk] failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePgPool().catch(() => undefined);
  });
