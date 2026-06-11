import { runBacktest } from "@/lib/backtest/backtestEngine";
import type { BacktestConfig, BacktestInput, StrategyRouter } from "@/lib/backtest/types";
import type { Bar, FeatureSnapshot, RegimeContext, StrategySignal } from "@/lib/quant/types";
import type { RiskConfig } from "@/lib/risk/types";
import { RISK_VERSION } from "@/lib/versions";

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++;
    console.log(`PASS: ${name}`);
  } else {
    failed++;
    console.error(`FAIL: ${name}`, detail ?? "");
  }
}

function ts(hour: number): string {
  return new Date(Date.UTC(2026, 0, 1, hour)).toISOString();
}

function bar(hour: number, fields: Partial<Bar> = {}): Bar {
  const price = fields.close ?? fields.open ?? 100;
  return {
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
    ts: ts(hour),
    open: price,
    high: price + 1,
    low: price - 1,
    close: price,
    volume: 1,
    ...fields,
  };
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

function riskConfig(overrides: Partial<RiskConfig> = {}): RiskConfig {
  return {
    enabled: true,
    maxRiskPerTradePct: 0.01,
    maxDailyLossPct: 0.02,
    maxWeeklyLossPct: 0.05,
    maxOpenPositions: 1,
    maxSymbolExposurePct: 1,
    maxPortfolioExposurePct: 1,
    minRegimeReliability: 0.5,
    blockedRegimes: [],
    allowLong: true,
    allowShort: false,
    allowDefaultStopFallback: false,
    defaultStopLossPct: 0.02,
    defaultTakeProfitPct: 0.04,
    maxLeverage: 1,
    staleSignalMaxAgeMs: 2 * 60 * 60 * 1000,
    duplicateCooldownMs: 0,
    maxConsecutiveLosses: 3,
    highVolSizeMultiplier: 0.5,
    chopSizeMultiplier: 0.25,
    newsShockBlocksTrading: true,
    killSwitchEnabled: false,
    ...overrides,
  };
}

function backtestConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
    strategyId: "momentum_continuation",
    featureVersion: "features.test.v1",
    startTs: ts(0),
    endTs: ts(5),
    initialCapital: 10_000,
    riskPerTradePct: 0.01,
    maxPositionPct: 1,
    maxConcurrentPositions: 1,
    feeBps: 10,
    slippageBps: 0,
    defaultRewardRisk: 2,
    closeOpenPositionAtEnd: true,
    enterOnNextBarOpen: true,
    sameBarStopFirst: true,
    ...overrides,
  };
}

function baseInput(overrides: Partial<BacktestInput> = {}): BacktestInput {
  return {
    config: backtestConfig(),
    bars: [
      bar(0, { open: 100, high: 101, low: 99, close: 100 }),
      bar(1, { open: 104, high: 105, low: 103, close: 104 }),
      bar(2, { open: 100, high: 103, low: 99, close: 101 }),
      bar(3, { open: 101, high: 113, low: 100, close: 112 }),
      bar(4, { open: 112, high: 113, low: 111, close: 112 }),
    ],
    features: [
      feature(0, { close: 100, ema20: 98, ema20Slope: 0.3, macdHist: 0.2, rsi14: 56, atr14: 4, candleRangeAtr: 1 }),
      feature(1, { close: 104, ema20: 100, ema20Slope: 0.8, macdHist: 0.5, rsi14: 58, atr14: 4, candleRangeAtr: 1 }),
    ],
    regimes: [{ regime: "TREND_UP", reliability: 0.9, ts: ts(0) }],
    ...overrides,
  };
}

function withRisk(input: BacktestInput, overrides: Partial<RiskConfig> = {}): BacktestInput {
  return {
    ...input,
    config: {
      ...input.config,
      risk: { enabled: true, config: riskConfig(overrides) },
    },
  };
}

function fallbackRouter(): StrategyRouter {
  return {
    id: "fallback_test_router",
    version: "fallback.test.v1",
    evaluate({ current }): StrategySignal | null {
      if (current.ts !== ts(1)) return null;
      return {
        symbol: current.symbol,
        exchange: current.exchange,
        timeframe: current.timeframe,
        ts: current.ts,
        strategyId: "fallback_test",
        signalType: "trigger",
        direction: "long",
        confidence: 1,
        invalidationPrice: null,
        stopLoss: null,
        takeProfit: null,
        features: current,
        reasons: ["fallback smoke"],
        strategyVersion: "fallback.test.v1",
        featureVersion: current.featureVersion,
      };
    },
  };
}

function testDisabledCompatibility(): void {
  console.log("\n=== disabled compatibility ===");
  const raw = runBacktest(baseInput());
  const disabledInput = baseInput();
  disabledInput.config = {
    ...disabledInput.config,
    risk: { enabled: false, config: riskConfig() },
  };
  const disabled = runBacktest(disabledInput);
  assert("risk disabled preserves trades", JSON.stringify(disabled.trades) === JSON.stringify(raw.trades));
  assert("risk disabled preserves metrics", JSON.stringify(disabled.metrics) === JSON.stringify(raw.metrics));
  assert("risk disabled omits overlay summary", disabled.riskOverlay === undefined);
  assert("risk disabled omits risk events", disabled.riskEvents === undefined);
}

function testApprovalAndAdditiveMetrics(): void {
  console.log("\n=== approval and additive metrics ===");
  const result = runBacktest(withRisk(baseInput()));
  assert("risk enabled can approve trade", result.riskOverlay?.riskApprovedTrades === 1, result.riskOverlay);
  assert("approved trade retains risk metadata", result.trades[0]?.riskApproved === true, result.trades[0]);
  assert("riskVersion is retained in risk event", result.riskEvents?.[0]?.riskVersion === RISK_VERSION, result.riskEvents);
  assert("raw metrics remain additive", result.riskOverlay?.rawMetrics.numberOfTrades === 1, result.riskOverlay);
  assert("risk-adjusted metrics remain additive", result.riskOverlay?.riskAdjustedMetrics === result.metrics, result.riskOverlay);
  assert("risk-adjusted trade count is <= raw trade count", (result.riskOverlay?.riskAdjustedMetrics.numberOfTrades ?? 1) <= (result.riskOverlay?.rawMetrics.numberOfTrades ?? 0));
  assert("max risk used reflects approved stop exposure", (result.riskOverlay?.maxRiskUsdUsed ?? 0) > 0, result.riskOverlay);
}

function testBlocksAndCounters(): void {
  console.log("\n=== blocks and counters ===");
  const blocked = runBacktest(withRisk(baseInput(), { blockedRegimes: ["TREND_UP"] }));
  assert("risk enabled can block trade", blocked.trades.length === 0, blocked.trades);
  assert("blocked trade is counted by reason", blocked.riskOverlay?.riskBlockedByReason.REGIME_BLOCKED === 1, blocked.riskOverlay);
  assert("regime block aggregate is counted", blocked.riskOverlay?.regimeBlocks === 1, blocked.riskOverlay);
  assert("blocked event retains decision", blocked.riskEvents?.[0]?.approved === false, blocked.riskEvents);

  const missing = runBacktest(withRisk(baseInput({ regimes: undefined })));
  assert("missing regime is explicitly blocked", missing.riskEvents?.[0]?.blockedBy.includes("REGIME_CONTEXT_MISSING") === true, missing.riskEvents);
  assert("missing regime increments regime blocks", missing.riskOverlay?.regimeBlocks === 1, missing.riskOverlay);

  const killed = runBacktest(withRisk(baseInput(), { killSwitchEnabled: true }));
  assert("kill switch blocks all new entries", killed.trades.length === 0, killed.trades);
  assert("kill switch block is aggregated", killed.riskOverlay?.killSwitchBlocks === 1, killed.riskOverlay);
}

function testDefaultStopFallback(): void {
  console.log("\n=== default stop fallback ===");
  const permissiveBase = baseInput({ strategyRouter: fallbackRouter() });
  permissiveBase.config = { ...permissiveBase.config, strategyId: "fallback_test_router" };
  const permissive = runBacktest(withRisk(permissiveBase, { allowDefaultStopFallback: true }));
  assert("default stop fallback can approve simulated entry", permissive.trades.length === 1, permissive.riskEvents);
  assert("default stop fallback warning is retained", permissive.riskEvents?.[0]?.warnings.includes("DEFAULT_STOP_FALLBACK_USED") === true, permissive.riskEvents);

  const strictBase = baseInput({ strategyRouter: fallbackRouter() });
  strictBase.config = { ...strictBase.config, strategyId: "fallback_test_router" };
  const strict = runBacktest(withRisk(strictBase, { allowDefaultStopFallback: false }));
  assert("strict stop policy blocks simulated entry", strict.trades.length === 0, strict.riskEvents);
  assert("strict stop policy records missing stop", strict.riskEvents?.[0]?.blockedBy.includes("STOP_LOSS_MISSING") === true, strict.riskEvents);
}

function testDeterminism(): void {
  console.log("\n=== overlay determinism ===");
  const input = withRisk(baseInput());
  const before = JSON.stringify(input);
  const first = runBacktest(input);
  const second = runBacktest(input);
  assert("same overlay input produces identical output", JSON.stringify(first) === JSON.stringify(second));
  assert("overlay does not mutate input", JSON.stringify(input) === before);
}

function main(): void {
  testDisabledCompatibility();
  testApprovalAndAdditiveMetrics();
  testBlocksAndCounters();
  testDefaultStopFallback();
  testDeterminism();

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`} (${passed} passed)`);
  if (failed > 0) process.exit(1);
}

main();
