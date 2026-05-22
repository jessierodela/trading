import { computeFeaturesSegmented } from "@/lib/features/engine";
import { getPgPool, PgBarStore, PgFeatureStore } from "@/lib/storage";
import { closePgPool } from "@/lib/storage/clients";
import { FEATURE_VERSION } from "@/lib/versions";
import { insertFeatureSnapshotsBulk } from "./bulkFeaturePersistence";
import type { Timeframe } from "@/lib/quant/types";

const SYMBOL = "BTC-USD";
const EXCHANGE = "COINBASE";
const TIMEFRAMES: Timeframe[] = ["1h", "1d"];

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

async function boundsFor(timeframe: Timeframe): Promise<{ startTs: string; endTs: string } | null> {
  const pool = getPgPool();
  const { rows } = await pool.query<{ min_ts: Date | null; max_ts: Date | null }>(
    `select min(ts) as min_ts, max(ts) as max_ts
     from market_bars
     where symbol = $1 and exchange = $2 and timeframe = $3`,
    [SYMBOL, EXCHANGE, timeframe],
  );
  const row = rows[0];
  if (!row?.min_ts || !row.max_ts) return null;
  const stepMs = timeframe === "1d" ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  return {
    startTs: row.min_ts.toISOString(),
    endTs: new Date(row.max_ts.getTime() + stepMs).toISOString(),
  };
}

async function countFeatures(timeframe: Timeframe): Promise<number> {
  const pool = getPgPool();
  const { rows } = await pool.query<{ count: string }>(
    `select count(*)::text as count
     from feature_snapshots
     where symbol = $1 and exchange = $2 and timeframe = $3 and feature_version = $4`,
    [SYMBOL, EXCHANGE, timeframe, FEATURE_VERSION],
  );
  return Number(rows[0]?.count ?? 0);
}

async function computeFor(timeframe: Timeframe): Promise<void> {
  const bounds = await boundsFor(timeframe);
  if (!bounds) {
    console.log(`[features:btc:bulk] no ${timeframe} bars found`);
    return;
  }

  const pool = getPgPool();
  const barStore = new PgBarStore(pool);
  const featureStore = new PgFeatureStore(pool);
  const chunkSize = envNumber("FEATURE_INSERT_CHUNK", 500);
  const bars = await barStore.fetchRange({ symbol: SYMBOL, exchange: EXCHANGE, timeframe }, bounds);
  const result = computeFeaturesSegmented(bars);
  const inserted = await insertFeatureSnapshotsBulk(pool, result.rows, chunkSize);
  const totalFeatures = await countFeatures(timeframe);
  const latest = await featureStore.fetchLatest({ symbol: SYMBOL, exchange: EXCHANGE, timeframe, featureVersion: FEATURE_VERSION });

  console.log(
    `[features:btc:bulk] ${timeframe}: bars=${bars.length} computed=${result.rows.length} ` +
    `inserted=${inserted} totalFeatures=${totalFeatures} latest=${latest?.ts ?? "none"} ` +
    `segments=${result.segments.length} gaps=${result.gapCount}`,
  );
}

async function main(): Promise<void> {
  for (const timeframe of TIMEFRAMES) {
    await computeFor(timeframe);
  }
}

main()
  .catch((err) => {
    console.error("[features:btc:bulk] failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePgPool().catch(() => undefined);
  });
