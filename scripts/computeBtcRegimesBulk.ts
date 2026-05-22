import { buildOhlcvProxyRegimes } from "@/lib/backtest/regimeValidation";
import { getPgPool, PgBarStore, PgFeatureStore } from "@/lib/storage";
import { closePgPool } from "@/lib/storage/clients";
import {
  FEATURE_VERSION,
  REGIME_DETECTOR_PROMPT_VERSION,
  REGIME_MODEL_VERSION,
} from "@/lib/versions";
import type { Bar, FeatureSnapshot, RegimeContext, RegimeLabel } from "@/lib/quant/types";

const SYMBOL = "BTC-USD";
const EXCHANGE = "COINBASE";
const TIMEFRAME = "1h";
const MODEL_VERSION = `${REGIME_MODEL_VERSION}.deterministic-bulk.window144.coverage-v6`;

interface RegimeStoragePolicy {
  directionalBias: "UP" | "DOWN" | "NEUTRAL";
  tradePermission: "ALLOW_UP_ONLY" | "ALLOW_DOWN_ONLY" | "ALLOW_BOTH" | "ALLOW_BOTH_SMALL" | "BLOCK_OR_EXCEPTIONAL_ONLY" | "BLOCK";
  edgeMultiplier: number;
  sizeMultiplier: number;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function policyFor(regime: RegimeLabel): RegimeStoragePolicy {
  switch (regime) {
    case "TREND_UP":
      return { directionalBias: "UP", tradePermission: "ALLOW_UP_ONLY", edgeMultiplier: 1, sizeMultiplier: 1 };
    case "TREND_DOWN":
      return { directionalBias: "DOWN", tradePermission: "ALLOW_DOWN_ONLY", edgeMultiplier: 0.8, sizeMultiplier: 0.7 };
    case "HIGH_VOL":
      return { directionalBias: "NEUTRAL", tradePermission: "ALLOW_BOTH_SMALL", edgeMultiplier: 0.8, sizeMultiplier: 0.5 };
    case "LOW_VOL":
      return { directionalBias: "NEUTRAL", tradePermission: "ALLOW_BOTH_SMALL", edgeMultiplier: 0.6, sizeMultiplier: 0.4 };
    case "NEWS_SHOCK":
      return { directionalBias: "NEUTRAL", tradePermission: "BLOCK_OR_EXCEPTIONAL_ONLY", edgeMultiplier: 0.2, sizeMultiplier: 0.1 };
    case "CHOP":
      return { directionalBias: "NEUTRAL", tradePermission: "ALLOW_BOTH_SMALL", edgeMultiplier: 0.4, sizeMultiplier: 0.25 };
  }
}

function featureAlignedBars(bars: Bar[], features: FeatureSnapshot[]): Bar[] {
  const featureTs = new Set(features.map((feature) => feature.ts));
  return bars.filter((bar) => featureTs.has(bar.ts));
}

async function boundsFor(): Promise<{ startTs: string; endTs: string } | null> {
  const pool = getPgPool();
  const { rows } = await pool.query<{ min_ts: Date | null; max_ts: Date | null }>(
    `select min(ts) as min_ts, max(ts) as max_ts
     from market_bars
     where symbol = $1 and exchange = $2 and timeframe = $3`,
    [SYMBOL, EXCHANGE, TIMEFRAME],
  );
  const row = rows[0];
  if (!row?.min_ts || !row.max_ts) return null;
  return {
    startTs: row.min_ts.toISOString(),
    endTs: new Date(row.max_ts.getTime() + 60 * 60 * 1000).toISOString(),
  };
}

async function insertRegimesBulk(
  regimes: RegimeContext[],
  featuresByTs: Map<string, FeatureSnapshot>,
  chunkSize: number,
): Promise<number> {
  const pool = getPgPool();
  let inserted = 0;

  for (let offset = 0; offset < regimes.length; offset += chunkSize) {
    const chunk = regimes.slice(offset, offset + chunkSize);
    const valuesSql: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    for (const regime of chunk) {
      const feature = featuresByTs.get(regime.ts);
      const policy = policyFor(regime.regime);
      const rawResponse = {
        source: "deterministic_bulk_research_classifier",
        featureVersion: FEATURE_VERSION,
        timeframe: TIMEFRAME,
        atrPct: feature?.atrPct ?? null,
        ema20Slope: feature?.ema20Slope ?? null,
        rsi14: feature?.rsi14 ?? null,
        macdHist: feature?.macdHist ?? null,
      };
      const row = [
        SYMBOL,
        EXCHANGE,
        regime.ts,
        regime.regime,
        regime.reliability,
        policy.directionalBias,
        policy.tradePermission,
        policy.edgeMultiplier,
        policy.sizeMultiplier,
        `Bulk deterministic A6-compatible research regime: ${regime.regime}`,
        JSON.stringify(rawResponse),
        MODEL_VERSION,
        REGIME_DETECTOR_PROMPT_VERSION,
        FEATURE_VERSION,
      ];
      valuesSql.push(`(${row.map(() => `$${paramIndex++}`).join(", ")})`);
      params.push(...row);
    }

    const { rowCount } = await pool.query(
      `with incoming (
         symbol, exchange, ts, regime, reliability, directional_bias, trade_permission,
         edge_multiplier, size_multiplier, reason, raw_response,
         regime_model_version, prompt_version, feature_version
       ) as (
         values ${valuesSql.join(", ")}
       )
       insert into regime_snapshots (
         symbol, exchange, ts, regime, reliability, directional_bias, trade_permission,
         edge_multiplier, size_multiplier, reason, raw_response,
         regime_model_version, prompt_version, feature_version
       )
       select
         i.symbol,
         i.exchange,
         i.ts::timestamptz,
         i.regime,
         i.reliability::numeric,
         i.directional_bias,
         i.trade_permission,
         i.edge_multiplier::numeric,
         i.size_multiplier::numeric,
         i.reason,
         i.raw_response::jsonb,
         i.regime_model_version,
         i.prompt_version,
         i.feature_version
       from incoming i
       where not exists (
         select 1
         from regime_snapshots existing
         where existing.symbol = i.symbol
           and existing.exchange = i.exchange
           and existing.ts = i.ts::timestamptz
           and existing.regime_model_version = i.regime_model_version
           and existing.feature_version = i.feature_version
       )`,
      params,
    );
    inserted += rowCount ?? 0;
  }

  return inserted;
}

async function countRegimes(): Promise<number> {
  const pool = getPgPool();
  const { rows } = await pool.query<{ count: string }>(
    `select count(*)::text as count
     from regime_snapshots
     where symbol = $1 and exchange = $2
       and regime_model_version = $3
       and feature_version = $4`,
    [SYMBOL, EXCHANGE, MODEL_VERSION, FEATURE_VERSION],
  );
  return Number(rows[0]?.count ?? 0);
}

async function main(): Promise<void> {
  const bounds = await boundsFor();
  if (!bounds) {
    console.log("[regimes:btc:bulk] no 1h bars found");
    return;
  }

  const pool = getPgPool();
  const barStore = new PgBarStore(pool);
  const featureStore = new PgFeatureStore(pool);
  const chunkSize = envNumber("REGIME_INSERT_CHUNK", 500);
  const lookbackBars = envNumber("REGIME_PROXY_LOOKBACK_BARS", 144);
  const [bars, features] = await Promise.all([
    barStore.fetchRange({ symbol: SYMBOL, exchange: EXCHANGE, timeframe: TIMEFRAME }, bounds),
    featureStore.fetchRange({ symbol: SYMBOL, exchange: EXCHANGE, timeframe: TIMEFRAME, featureVersion: FEATURE_VERSION }, bounds),
  ]);
  const executableBars = featureAlignedBars(bars, features);
  const regimes = buildOhlcvProxyRegimes(executableBars, features, lookbackBars);
  const featuresByTs = new Map(features.map((feature) => [feature.ts, feature]));
  const inserted = await insertRegimesBulk(regimes, featuresByTs, chunkSize);
  const total = await countRegimes();

  console.log(
    `[regimes:btc:bulk] bars=${bars.length} features=${features.length} executableBars=${executableBars.length} ` +
    `computed=${regimes.length} inserted=${inserted} total=${total} ` +
    `model=${MODEL_VERSION}`,
  );
}

main()
  .catch((err) => {
    console.error("[regimes:btc:bulk] failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePgPool().catch(() => undefined);
  });
