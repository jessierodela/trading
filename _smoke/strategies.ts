import type { FeatureSnapshot, RegimeContext, StrategySignal } from "../lib/quant/types";
import { InMemorySignalStore } from "../lib/storage";
import { breakoutExpansion } from "../lib/strategies/breakoutExpansion";
import { meanReversionBounce } from "../lib/strategies/meanReversionBounce";
import { momentumContinuation } from "../lib/strategies/momentumContinuation";
import { REFINED_STRATEGY_VARIANTS } from "../lib/strategies/refinement/strategyVariants";
import { runStrategyWindow } from "../lib/strategies/runStrategyWindow";
import { runStrategies, STRATEGY_REGISTRY, getStrategyById } from "../lib/strategies/strategyRegistry";
import { trendPullback } from "../lib/strategies/trendPullback";
import { STRATEGY_VERSIONS } from "../lib/versions";

let passed = 0;
let failed = 0;

function assert(label: string, cond: boolean, details?: unknown): void {
  if (cond) {
    passed++;
    console.log(`PASS: ${label}`);
  } else {
    failed++;
    console.log(`FAIL: ${label}`);
    if (details !== undefined) console.log("       ", details);
  }
}

function ts(hourOffset: number): string {
  return new Date(Date.UTC(2026, 0, 1, hourOffset, 0, 0, 0)).toISOString();
}

function feature(hour: number, fields: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
  return {
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
    ts: ts(hour),
    close: 100,
    featureVersion: "features.test.v1",
    ...fields,
  };
}

function regime(regimeName: RegimeContext["regime"], reliability = 0.8, hour = 1): RegimeContext {
  return { regime: regimeName, reliability, ts: ts(hour) };
}

function previousMomentum(): FeatureSnapshot {
  return feature(0, {
    close: 100,
    ema20: 98,
    ema20Slope: 0.5,
    macdHist: 0.2,
    rsi14: 56,
    atr14: 4,
    candleRangeAtr: 1.1,
  });
}

function bullishMomentum(hour = 1): FeatureSnapshot {
  return feature(hour, {
    close: 104,
    ema20: 100,
    ema20Slope: 0.8,
    macdHist: 0.5,
    rsi14: 58,
    atr14: 4,
    candleRangeAtr: 1.2,
  });
}

function pullbackCurrent(hour = 1): FeatureSnapshot {
  return feature(hour, {
    close: 100,
    ema20: 101,
    rsi14: 45,
    macdHist: 0.2,
    atr14: 4,
    daily_ema50AboveEma200: true,
  });
}

function breakoutCurrent(hour = 1): FeatureSnapshot {
  return feature(hour, {
    close: 110,
    bbUpper: 108,
    bbMiddle: 101,
    bbWidth: 0.14,
    bbWidthPrev: 0.1,
    relativeVolume20: 1.4,
    macdHist: 0.6,
    atr14: 5,
    atrPct: 4,
    candleRangeAtr: 1.8,
  });
}

function bounceCurrent(hour = 1): FeatureSnapshot {
  return feature(hour, {
    close: 92,
    ema20: 100,
    rsi14: 34,
    macdHist: -0.7,
    atr14: 4,
    distanceFromEma20Atr: -2,
  });
}

function assertSignalShape(prefix: string, signal: StrategySignal): void {
  assert(`${prefix}: strategyId set`, signal.strategyId.length > 0);
  assert(`${prefix}: strategyVersion set`, signal.strategyVersion.length > 0);
  assert(`${prefix}: featureVersion set`, signal.featureVersion.length > 0);
  assert(`${prefix}: features snapshot attached`, signal.features.ts === signal.ts);
  assert(`${prefix}: reasons present`, signal.reasons.length > 0);
  assert(`${prefix}: confidence in [0,1]`, signal.confidence >= 0 && signal.confidence <= 1);
  assert(`${prefix}: direction long`, signal.direction === "long");
  assert(`${prefix}: stopLoss populated`, typeof signal.stopLoss === "number");
}

async function testStrategies(): Promise<void> {
  console.log("\n=== strategy definitions ===");
  assert("registry includes base and refined strategies", STRATEGY_REGISTRY.length >= 8);
  assert("registry lookup momentum works", getStrategyById("momentum_continuation") === momentumContinuation);
  assert("registry lookup refined momentum works", getStrategyById("momentum_continuation_refined_v1") === REFINED_STRATEGY_VARIANTS[0]);
  assert("registry includes all refined variants", REFINED_STRATEGY_VARIANTS.every((strategy) => getStrategyById(strategy.id) === strategy));
  assert("registry lookup missing returns null", getStrategyById("missing") === null);
  assert("momentum version matches STRATEGY_VERSIONS", momentumContinuation.version === STRATEGY_VERSIONS.momentumContinuation);
  assert("trend version matches STRATEGY_VERSIONS", trendPullback.version === STRATEGY_VERSIONS.trendPullback);
  assert("breakout version matches STRATEGY_VERSIONS", breakoutExpansion.version === STRATEGY_VERSIONS.breakoutExpansion);
  assert("bounce version matches STRATEGY_VERSIONS", meanReversionBounce.version === STRATEGY_VERSIONS.meanReversionBounce);

  console.log("\n=== required fields and basic signals ===");
  const missing = momentumContinuation.evaluate({
    current: bullishMomentum(1),
    previous: { ...previousMomentum(), macdHist: null },
    recent: [],
  });
  assert("momentum returns null when required previous indicator is null", missing === null);

  const missingCurrent = momentumContinuation.evaluate({
    current: { ...bullishMomentum(1), ema20: null },
    previous: previousMomentum(),
    recent: [],
  });
  assert("momentum returns null when required current indicator is null", missingCurrent === null);

  const momentum = momentumContinuation.evaluate({
    current: bullishMomentum(1),
    previous: previousMomentum(),
    recent: [previousMomentum(), bullishMomentum(1)],
    regime: regime("TREND_UP"),
  });
  assert("momentum emits trigger on crafted bullish features", momentum?.signalType === "trigger", momentum);
  assert("momentum strategyId stable", momentum?.strategyId === "momentum_continuation");
  assert("momentum invalidation equals stop", momentum?.invalidationPrice === momentum?.stopLoss);
  if (momentum) assertSignalShape("momentum", momentum);

  const trend = trendPullback.evaluate({
    current: pullbackCurrent(1),
    previous: feature(0, { ...pullbackCurrent(0), macdHist: 0.05 }),
    recent: [],
  });
  assert("trend pullback emits trigger on crafted pullback", trend?.signalType === "trigger", trend);
  assert("trend strategyId stable", trend?.strategyId === "trend_pullback");
  assert("trend stop below ema20", typeof trend?.stopLoss === "number" && trend.stopLoss < pullbackCurrent(1).ema20!);
  if (trend) assertSignalShape("trend", trend);

  const trendSetup = trendPullback.evaluate({
    current: { ...pullbackCurrent(1), rsi14: 42, macdHist: 0.1 },
    previous: feature(0, { macdHist: 0.2 }),
    recent: [],
  });
  assert("trend pullback can emit setup while forming", trendSetup?.signalType === "setup", trendSetup);

  const breakout = breakoutExpansion.evaluate({
    current: breakoutCurrent(1),
    previous: feature(0),
    recent: [],
  });
  assert("breakout expansion emits trigger", breakout?.signalType === "trigger", breakout);
  assert("breakout strategyId stable", breakout?.strategyId === "breakout_expansion");
  assert("breakout stop uses middle band", breakout?.stopLoss === breakoutCurrent(1).bbMiddle);
  if (breakout) assertSignalShape("breakout", breakout);

  const bounce = meanReversionBounce.evaluate({
    current: bounceCurrent(1),
    previous: feature(0, { rsi14: 32, macdHist: -1.2 }),
    recent: [],
  });
  assert("mean reversion emits trigger on stretched bounce", bounce?.signalType === "trigger", bounce);
  assert("mean reversion strategyId stable", bounce?.strategyId === "mean_reversion_bounce");
  assert("mean reversion confidence capped", typeof bounce?.confidence === "number" && bounce.confidence <= 0.65);
  if (bounce) assertSignalShape("bounce", bounce);

  console.log("\n=== regime handling ===");
  const newsBlocked = runStrategies({
    current: bullishMomentum(1),
    previous: previousMomentum(),
    recent: [],
    regime: regime("NEWS_SHOCK"),
  });
  assert("NEWS_SHOCK blocks entry signals", newsBlocked.length === 0, newsBlocked);

  const normalMomentum = momentumContinuation.evaluate({
    current: bullishMomentum(1),
    previous: previousMomentum(),
    recent: [],
    regime: regime("TREND_UP"),
  });
  const chopMomentum = momentumContinuation.evaluate({
    current: bullishMomentum(1),
    previous: previousMomentum(),
    recent: [],
    regime: regime("CHOP"),
  });
  assert("CHOP downgrades momentum trigger to setup", chopMomentum?.signalType === "setup", chopMomentum);
  assert("CHOP reduces momentum confidence", !!normalMomentum && !!chopMomentum && chopMomentum.confidence < normalMomentum.confidence);

  const downMomentum = momentumContinuation.evaluate({
    current: bullishMomentum(1),
    previous: previousMomentum(),
    recent: [],
    regime: regime("TREND_DOWN", 0.9),
  });
  assert("reliable TREND_DOWN downgrades long momentum", downMomentum?.signalType === "setup", downMomentum);
  assert("reliable TREND_DOWN lowers confidence", !!normalMomentum && !!downMomentum && downMomentum.confidence < normalMomentum.confidence);

  const downBounce = meanReversionBounce.evaluate({
    current: bounceCurrent(1),
    previous: feature(0, { rsi14: 32, macdHist: -1.2 }),
    recent: [],
    regime: regime("TREND_DOWN", 0.9),
  });
  assert("reliable TREND_DOWN keeps bounce as setup", downBounce?.signalType === "setup", downBounce);

  console.log("\n=== determinism and registry output ===");
  const input = {
    current: bullishMomentum(1),
    previous: previousMomentum(),
    recent: [previousMomentum(), bullishMomentum(1)],
    regime: regime("TREND_UP"),
  };
  assert("same strategy input twice produces identical JSON", JSON.stringify(runStrategies(input)) === JSON.stringify(runStrategies(input)));

  const registrySignals = runStrategies(input);
  const uniqueStrategies = new Set(registrySignals.map((s) => s.strategyId));
  assert("runStrategies returns no more than one signal per strategy", registrySignals.length === uniqueStrategies.size);
  assert("runStrategies emits at least one signal for bullish input", registrySignals.length >= 1);
  for (const signal of registrySignals) assertSignalShape(`registry ${signal.strategyId}`, signal);

  const noVersion = runStrategies({
    current: { ...bullishMomentum(1), featureVersion: "" },
    previous: previousMomentum(),
    recent: [],
  });
  assert("no signal emitted when featureVersion is missing", noVersion.length === 0, noVersion);
}

async function testWindowRunner(): Promise<void> {
  console.log("\n=== window runner ===");
  const windowFeatures = [
    previousMomentum(),
    bullishMomentum(1),
    { ...bullishMomentum(2), macdHist: 0.7, close: 105 },
  ];
  const result = await runStrategyWindow({ features: windowFeatures });
  assert("window reads all features", result.featuresRead === 3);
  assert("window emits expected momentum signals", (result.byStrategy.momentum_continuation ?? 0) === 2, result.byStrategy);
  assert("window inserted count zero without persist", result.inserted === 0);
  assert("window duplicate count zero without persist", result.duplicatesSkipped === 0);
  assert("window returns flat signals", result.signals.every((s) => s.strategyId));

  const unsortedDaily = await runStrategyWindow({
    features: [
      feature(24, { macdHist: 0 }),
      { ...pullbackCurrent(25), macdHist: -0.1, daily_ema50AboveEma200: null, daily_priceAboveEma200: null },
    ],
    dailyFeatures: [
      feature(0, { timeframe: "1d", close: 150, ema50: 140, ema200: 100 }),
      feature(-24, { timeframe: "1d", close: 80, ema50: 90, ema200: 100 }),
    ],
  });
  assert("window sorts unsorted daily features before selecting context", (unsortedDaily.byStrategy.trend_pullback ?? 0) === 1, unsortedDaily.byStrategy);

  const sameDayDaily = await runStrategyWindow({
    features: [
      feature(24, { macdHist: 0 }),
      { ...pullbackCurrent(25), macdHist: -0.1, daily_ema50AboveEma200: null, daily_priceAboveEma200: null },
    ],
    dailyFeatures: [
      feature(24, { timeframe: "1d", close: 150, ema50: 140, ema200: 100 }),
      feature(0, { timeframe: "1d", close: 80, ema50: 90, ema200: 100 }),
    ],
  });
  assert("window does not use same-day daily features for intraday signals", (sameDayDaily.byStrategy.trend_pullback ?? 0) === 0, sameDayDaily.byStrategy);

  let mixedThrew = false;
  try {
    await runStrategyWindow({
      features: [previousMomentum(), { ...bullishMomentum(1), symbol: "ETH-USD" }],
    });
  } catch {
    mixedThrew = true;
  }
  assert("window throws on mixed symbol", mixedThrew);

  let exchangeThrew = false;
  try {
    await runStrategyWindow({
      features: [previousMomentum(), { ...bullishMomentum(1), exchange: "BINANCE" }],
    });
  } catch {
    exchangeThrew = true;
  }
  assert("window throws on mixed exchange", exchangeThrew);

  let timeframeThrew = false;
  try {
    await runStrategyWindow({
      features: [previousMomentum(), { ...bullishMomentum(1), timeframe: "15m" }],
    });
  } catch {
    timeframeThrew = true;
  }
  assert("window throws on mixed timeframe", timeframeThrew);

  let duplicateThrew = false;
  try {
    await runStrategyWindow({ features: [previousMomentum(), previousMomentum()] });
  } catch {
    duplicateThrew = true;
  }
  assert("window throws on duplicate timestamps", duplicateThrew);

  let descendingThrew = false;
  try {
    await runStrategyWindow({ features: [bullishMomentum(1), previousMomentum()] });
  } catch {
    descendingThrew = true;
  }
  assert("window throws on non-ascending timestamps", descendingThrew);

  const store = new InMemorySignalStore();
  const persisted = await runStrategyWindow({
    features: windowFeatures,
    signalStore: store,
    persist: true,
  });
  assert("window can persist to InMemorySignalStore", persisted.inserted === persisted.signals.length, persisted);
  assert("window persistence has no duplicates first run", persisted.duplicatesSkipped === 0);

  const duplicatePersist = await runStrategyWindow({
    features: windowFeatures,
    signalStore: store,
    persist: true,
  });
  assert("duplicate persistence inserts zero", duplicatePersist.inserted === 0, duplicatePersist);
  assert("duplicate persistence counts skipped rows", duplicatePersist.duplicatesSkipped === duplicatePersist.signals.length, duplicatePersist);

  const active = await store.fetchActiveByStrategy("momentum_continuation", { startTs: ts(0), endTs: ts(4) });
  assert("persisted signals can be fetched by strategy", active.length === persisted.byStrategy.momentum_continuation);
  assert("persisted signals preserve strategy version", active.every((s) => s.strategyVersion === STRATEGY_VERSIONS.momentumContinuation));
  assert("persisted signals preserve feature version", active.every((s) => s.featureVersion === "features.test.v1"));
}

async function main(): Promise<void> {
  await testStrategies();
  await testWindowRunner();

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`} (${passed} passed)`);
  if (passed < 50) {
    console.log(`FAIL: expected at least 50 assertions, got ${passed}`);
    failed++;
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
