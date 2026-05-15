/**
 * _smoke_storage.ts
 *
 * Runs the same scenarios against InMemoryX stores and PgX stores. If both
 * pass, the implementations agree on behavior.
 *
 *   DATABASE_URL=postgres://... npx tsx _smoke_storage.ts
 *
 * With no DATABASE_URL, only the in-memory tests run.
 */
import {
  InMemoryBarStore, PgBarStore,
  InMemoryFeatureStore, PgFeatureStore,
  InMemorySignalStore, PgSignalStore,
  InMemoryRegimeStore, PgRegimeStore,
  type BarStore, type FeatureStore, type SignalStore, type RegimeStore,
  type RegimeSnapshotRow,
} from "@/lib/storage";
import { Pool } from "pg";
import type { Bar, FeatureSnapshot, StrategySignal } from "@/lib/quant/types";
import {
  FEATURE_VERSION, MOMENTUM_CONTINUATION_VERSION,
  REGIME_MODEL_VERSION, DATA_SOURCE_COINBASE_REST,
} from "@/lib/versions";

let failed = 0;
function assert(label: string, cond: boolean, details?: unknown) {
  if (!cond) {
    console.log(`FAIL: ${label}`);
    if (details !== undefined) console.log("       ", details);
    failed++;
  } else {
    console.log(`PASS: ${label}`);
  }
}

function eq(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(label, ok, ok ? undefined : { actual, expected });
}

const SYM = "BTC-USD", EX = "COINBASE" as const, TF = "1h" as const;
const t = (offset: number) => new Date(Date.UTC(2026, 4, 13, 14 + offset)).toISOString();

function makeBar(offset: number, close: number): Bar {
  return {
    symbol: SYM, exchange: EX, timeframe: TF, ts: t(offset),
    open: close - 100, high: close + 200, low: close - 200, close, volume: 100,
  };
}

function makeFeature(offset: number, close: number): FeatureSnapshot {
  return {
    symbol: SYM, exchange: EX, timeframe: TF, ts: t(offset),
    close, rsi14: 60 + offset, ema20: close - 50, atr14: 1400, atrPct: 1.33,
    daily_priceAboveEma200: true,
    featureVersion: FEATURE_VERSION,
  };
}

function makeSignal(offset: number, features: FeatureSnapshot): StrategySignal {
  return {
    symbol: SYM, exchange: EX, timeframe: TF, ts: t(offset),
    strategyId: "momentum_continuation",
    signalType: "trigger", direction: "long", confidence: 0.7,
    stopLoss: features.close - 1000, takeProfit: null,
    reasons: ["test"], features,
    strategyVersion: MOMENTUM_CONTINUATION_VERSION,
    featureVersion: FEATURE_VERSION,
  };
}

async function runScenarios(
  label: string,
  bars: BarStore, features: FeatureStore, signals: SignalStore, regimes: RegimeStore,
): Promise<void> {
  console.log(`\n=== ${label} ===`);

  // ── BarStore ─────────────────────────────────────────────────────────────
  await bars.insert(makeBar(0, 105_000), DATA_SOURCE_COINBASE_REST);
  await bars.insertMany([makeBar(1, 105_500), makeBar(2, 106_000)], DATA_SOURCE_COINBASE_REST);
  eq(`${label} bars.fetchRecent count`, (await bars.fetchRecent({ symbol: SYM, exchange: EX, timeframe: TF }, 10)).length, 3);
  eq(`${label} bars.latestTs`, await bars.latestTs({ symbol: SYM, exchange: EX, timeframe: TF }), t(2));

  // Conflict — should throw
  let conflictThrew = false;
  try {
    await bars.insert(makeBar(0, 0), DATA_SOURCE_COINBASE_REST);
  } catch { conflictThrew = true; }
  assert(`${label} bars duplicate throws`, conflictThrew);

  // onConflict: ignore — should not throw, should not insert
  const ignored = await bars.insertMany(
    [makeBar(0, 0), makeBar(2, 0), makeBar(3, 107_000)],
    DATA_SOURCE_COINBASE_REST,
    { onConflict: "ignore" },
  );
  eq(`${label} bars.insertMany ignore inserts only new`, ignored, 1);

  // Range query: [t(1), t(3)) = t(1), t(2)
  const range = await bars.fetchRange({ symbol: SYM, exchange: EX, timeframe: TF }, { startTs: t(1), endTs: t(3) });
  eq(`${label} bars.fetchRange count`, range.length, 2);
  eq(`${label} bars.fetchRange order ascending`, range.map((b) => b.ts), [t(1), t(2)]);

  // ── FeatureStore ─────────────────────────────────────────────────────────
  await features.insert(makeFeature(0, 105_000));
  await features.insert(makeFeature(1, 105_500));
  await features.insert(makeFeature(2, 106_000));

  const latest = await features.fetchLatest({ symbol: SYM, exchange: EX, timeframe: TF });
  eq(`${label} features.fetchLatest ts`,  latest?.ts, t(2));
  eq(`${label} features.fetchLatest rsi`, latest?.rsi14, 62);
  eq(`${label} features.fetchLatest daily flag round-trips bool`, latest?.daily_priceAboveEma200, true);

  // ── SignalStore ──────────────────────────────────────────────────────────
  const f0 = makeFeature(0, 105_000);
  const sig0 = await signals.insert(makeSignal(0, f0));
  await signals.insert(makeSignal(1, makeFeature(1, 105_500)));
  await signals.insert(makeSignal(2, makeFeature(2, 106_000)));

  const active = await signals.fetchActiveByStrategy("momentum_continuation", { startTs: t(-1), endTs: t(10) });
  eq(`${label} signals.fetchActiveByStrategy count`, active.length, 3);

  await signals.retract(sig0.id);
  const afterRetract = await signals.fetchActiveByStrategy("momentum_continuation", { startTs: t(-1), endTs: t(10) });
  eq(`${label} signals.retract drops one`, afterRetract.length, 2);

  // ── RegimeStore ──────────────────────────────────────────────────────────
  const reg: RegimeSnapshotRow = {
    symbol: SYM, exchange: EX, ts: t(0),
    regime: "TREND_UP", reliability: 0.82,
    directionalBias: "UP", tradePermission: "ALLOW_UP_ONLY",
    edgeMultiplier: 0.9, sizeMultiplier: 1.25,
    reason: "test",
    regimeModelVersion: REGIME_MODEL_VERSION,
  };
  await regimes.insert(reg);
  await regimes.insert({ ...reg, ts: t(1), regime: "CHOP", reliability: 0.6,
    directionalBias: "NEUTRAL", tradePermission: "BLOCK_OR_EXCEPTIONAL_ONLY",
    edgeMultiplier: 2.0, sizeMultiplier: 0.5 });

  const ctx = await regimes.latestAsContext({ symbol: SYM, exchange: EX });
  eq(`${label} regimes.latestAsContext returns latest`, ctx?.regime, "CHOP");
  eq(`${label} regimes.latestAsContext reliability`, ctx?.reliability, 0.6);
}

async function main(): Promise<void> {
  await runScenarios(
    "in-memory",
    new InMemoryBarStore(), new InMemoryFeatureStore(),
    new InMemorySignalStore(), new InMemoryRegimeStore(),
  );

  const dbUrl = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  if (dbUrl) {
    const pool = new Pool({ connectionString: dbUrl });
    // Truncate to start clean
    await pool.query(`
      truncate table fills, orders, positions, trade_intents,
                     strategy_signals, regime_snapshots,
                     feature_snapshots, market_bars,
                     agent_outputs
                     restart identity cascade;
    `);
    await runScenarios(
      "pg",
      new PgBarStore(pool), new PgFeatureStore(pool),
      new PgSignalStore(pool), new PgRegimeStore(pool),
    );
    await pool.end();
  } else {
    console.log("\n(skipping pg suite — set DATABASE_URL to enable)");
  }

  console.log(`\n${failed === 0 ? "✓ all checks passed" : `✗ ${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
