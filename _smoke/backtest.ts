import type { Bar, FeatureSnapshot, RegimeContext, StrategySignal } from "../lib/quant/types";
import { createOpenPositionFromSignal, runBacktest } from "../lib/backtest/backtestEngine";
import { calculateBacktestMetrics } from "../lib/backtest/metrics";
import { runPortfolioBacktest } from "../lib/backtest/portfolioBacktest";
import { buildOhlcvProxyRegimes, REQUIRED_REGIMES, runRegimeValidation } from "../lib/backtest/regimeValidation";
import { InMemoryBacktestReportStore } from "../lib/backtest/reportStore";
import { applyEntrySlippage, applyExitSlippage, feeForNotional } from "../lib/backtest/slippage";
import { defaultA6RegimeRouter } from "../lib/backtest/strategyRouter";
import type { BacktestConfig, BacktestInput, SimulatedTrade } from "../lib/backtest/types";
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

function near(actual: number | null | undefined, expected: number, eps = 1e-9): boolean {
  return typeof actual === "number" && Math.abs(actual - expected) <= eps;
}

function ts(hour: number): string {
  return new Date(Date.UTC(2026, 0, 1, hour, 0, 0, 0)).toISOString();
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

function prevFeature(hour = 0): FeatureSnapshot {
  return feature(hour, {
    close: 100,
    ema20: 98,
    ema20Slope: 0.3,
    macdHist: 0.2,
    rsi14: 56,
    atr14: 4,
    candleRangeAtr: 1,
  });
}

function signalFeature(hour = 1, fields: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
  return feature(hour, {
    close: 104,
    ema20: 100,
    ema20Slope: 0.8,
    macdHist: 0.5,
    rsi14: 58,
    atr14: 4,
    candleRangeAtr: 1,
    ...fields,
  });
}

function regime(regimeName: RegimeContext["regime"], hour: number): RegimeContext {
  return { regime: regimeName, reliability: 0.9, ts: ts(hour) };
}

function config(fields: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
    strategyId: "momentum_continuation",
    featureVersion: "features.test.v1",
    startTs: ts(0),
    endTs: ts(8),
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
    ...fields,
  };
}

function inputFor(
  bars: Bar[],
  features: FeatureSnapshot[],
  fields: Partial<BacktestInput> = {},
): BacktestInput {
  return { config: config({ endTs: bars[bars.length - 1].ts }), bars, features, ...fields };
}

function targetWinInput(fields: Partial<BacktestInput> = {}, cfg: Partial<BacktestConfig> = {}): BacktestInput {
  const bars = [
    bar(0, { open: 100, high: 101, low: 99, close: 100 }),
    bar(1, { open: 104, high: 105, low: 103, close: 104 }),
    bar(2, { open: 100, high: 103, low: 99, close: 101 }),
    bar(3, { open: 101, high: 113, low: 100, close: 112 }),
    bar(4, { open: 112, high: 113, low: 111, close: 112 }),
  ];
  return {
    config: config({ endTs: ts(5), ...cfg }),
    bars,
    features: [prevFeature(0), signalFeature(1)],
    ...fields,
  };
}

function stopLossInput(fields: Partial<BacktestInput> = {}, cfg: Partial<BacktestConfig> = {}): BacktestInput {
  const bars = [
    bar(0, { open: 100, high: 101, low: 99, close: 100 }),
    bar(1, { open: 104, high: 105, low: 103, close: 104 }),
    bar(2, { open: 100, high: 101, low: 93, close: 94 }),
    bar(3, { open: 94, high: 96, low: 92, close: 95 }),
  ];
  return {
    config: config({ endTs: ts(4), ...cfg }),
    bars,
    features: [prevFeature(0), signalFeature(1)],
    ...fields,
  };
}

function flatInput(closeAtEnd = true): BacktestInput {
  const bars = [
    bar(0, { open: 100, high: 101, low: 99, close: 100 }),
    bar(1, { open: 104, high: 105, low: 103, close: 104 }),
    bar(2, { open: 100, high: 105, low: 97, close: 101 }),
    bar(3, { open: 101, high: 106, low: 98, close: 102 }),
    bar(4, { open: 102, high: 107, low: 99, close: 103 }),
  ];
  return {
    config: config({ endTs: ts(5), closeOpenPositionAtEnd: closeAtEnd }),
    bars,
    features: [prevFeature(0), signalFeature(1)],
  };
}

function syntheticSignal(fields: Partial<StrategySignal> = {}): StrategySignal {
  const f = signalFeature(1);
  return {
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
    ts: ts(1),
    strategyId: "test",
    signalType: "trigger",
    direction: "long",
    confidence: 1,
    invalidationPrice: 94,
    stopLoss: 94,
    takeProfit: null,
    features: f,
    reasons: ["test"],
    strategyVersion: "test.v1",
    featureVersion: f.featureVersion,
    ...fields,
  };
}

function expectThrow(label: string, fn: () => void): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(label, threw);
}

function captureError(fn: () => void): Error | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function testValidation(): void {
  console.log("\n=== validation ===");
  const base = targetWinInput();
  expectThrow("rejects unsorted bars", () => runBacktest({ ...base, bars: [base.bars[1], base.bars[0]] }));
  expectThrow("rejects unsorted features", () => runBacktest({ ...base, features: [base.features[1], base.features[0]] }));
  expectThrow("rejects duplicate bar timestamps", () => runBacktest({ ...base, bars: [base.bars[0], base.bars[0]] }));
  expectThrow("rejects duplicate feature timestamps", () => runBacktest({ ...base, features: [base.features[0], base.features[0]] }));
  expectThrow("rejects mixed bar symbol", () => runBacktest({ ...base, bars: [{ ...base.bars[0], symbol: "ETH-USD" }, ...base.bars.slice(1)] }));
  expectThrow("rejects mixed feature exchange", () => runBacktest({ ...base, features: [base.features[0], { ...base.features[1], exchange: "BINANCE" }] }));
  expectThrow("rejects mixed timeframe", () => runBacktest({ ...base, bars: [{ ...base.bars[0], timeframe: "15m" }, ...base.bars.slice(1)] }));
  expectThrow("rejects feature without matching bar", () => runBacktest({ ...base, features: [prevFeature(0), signalFeature(7)] }));
  expectThrow("rejects invalid time range", () => runBacktest({ ...base, config: config({ startTs: ts(4), endTs: ts(4) }) }));
  expectThrow("rejects invalid initial capital", () => runBacktest({ ...base, config: config({ initialCapital: 0 }) }));
  expectThrow("rejects negative fee", () => runBacktest({ ...base, config: config({ feeBps: -1 }) }));
  expectThrow("rejects negative slippage", () => runBacktest({ ...base, config: config({ slippageBps: -1 }) }));
  expectThrow("rejects maxConcurrentPositions other than 1", () => runBacktest({ ...base, config: { ...config(), maxConcurrentPositions: 2 as 1 } }));
  expectThrow("rejects unknown strategy id", () => runBacktest({ ...base, config: config({ strategyId: "missing" }) }));

  const barGapError = captureError(() => runBacktest({
    ...base,
    bars: [base.bars[0], base.bars[1], base.bars[3], base.bars[4]],
    features: [base.features[0], base.features[1]],
  }));
  assert("rejects missing 1H bar gap", !!barGapError);
  assert("bar gap error message mentions gap", barGapError?.message.toLowerCase().includes("gap") === true);
  assert("bar gap error message mentions missing interval", barGapError?.message.toLowerCase().includes("missing interval") === true);

  const featureGapError = captureError(() => runBacktest({
    ...base,
    bars: [bar(0), bar(1), bar(2), bar(3), bar(4)],
    features: [prevFeature(0), signalFeature(2)],
  }));
  assert("rejects missing 1H feature gap", !!featureGapError);
  assert("feature gap error message mentions gap", featureGapError?.message.toLowerCase().includes("gap") === true);
  assert("feature gap error message mentions missing interval", featureGapError?.message.toLowerCase().includes("missing interval") === true);
}

function testSimulation(): void {
  console.log("\n=== simulation ===");
  const win = runBacktest(targetWinInput());
  const trade = win.trades[0];
  assert("take-profit trade is created", win.trades.length === 1, win.trades);
  assert("entry occurs on next bar open", trade.entryTs === ts(2));
  assert("entry does not use signal bar close", trade.entryPrice !== 104);
  assert("take-profit exit works", trade.reasonExited === "take_profit");
  assert("take-profit price derived from reward risk", near(trade.exitPrice, 112));
  assert("fees apply on both sides", near(trade.fees, feeForNotional(100 * trade.quantity, 10) + feeForNotional(112 * trade.quantity, 10)));
  assert("sizing uses risk per trade", near(trade.quantity, (10_000 * 0.01) / 6));
  assert("trade pnl positive on target", trade.pnl > 0);
  assert("trade stamps strategy version", trade.strategyVersion === STRATEGY_VERSIONS.momentumContinuation);
  assert("equity curve has one point per bar", win.equityCurve.length === targetWinInput().bars.length);

  const slippedInput = targetWinInput({}, { slippageBps: 100 });
  slippedInput.bars[3] = { ...slippedInput.bars[3], high: 116 };
  const slipped = runBacktest(slippedInput);
  const slippedTrade = slipped.trades[0];
  assert("long entry includes entry slippage", near(slippedTrade.entryPrice, applyEntrySlippage(100, "long", 100)));
  assert("long exit includes exit slippage", near(slippedTrade.exitPrice, applyExitSlippage(slippedTrade.takeProfit!, "long", 100)));
  assert("slippage cost is tracked", slippedTrade.slippageCost > 0);

  const stop = runBacktest(stopLossInput());
  assert("stop-loss exit works", stop.trades[0].reasonExited === "stop_loss");
  assert("stop-loss exit price equals stop before slippage", near(stop.trades[0].exitPrice, 94));
  assert("stop-loss trade loses money", stop.trades[0].pnl < 0);

  const both = runBacktest(stopLossInput({
    bars: [
      bar(0, { open: 100, high: 101, low: 99, close: 100 }),
      bar(1, { open: 104, high: 105, low: 103, close: 104 }),
      bar(2, { open: 100, high: 120, low: 93, close: 110 }),
    ],
  }, { endTs: ts(3) }));
  assert("same-bar stop and target uses stop first", both.trades[0].reasonExited === "stop_loss");

  const maxNotional = runBacktest(targetWinInput({}, { riskPerTradePct: 1, maxPositionPct: 0.1 }));
  assert("sizing respects max position notional", near(maxNotional.trades[0].quantity, (10_000 * 0.1) / 100));

  const noStop = createOpenPositionFromSignal(
    syntheticSignal({ stopLoss: null, invalidationPrice: null }),
    bar(2, { open: 100 }),
    2,
    10_000,
    targetWinInput(),
  );
  assert("trade with no stop is rejected", noStop === null);

  const badStop = createOpenPositionFromSignal(
    syntheticSignal({ stopLoss: 101, invalidationPrice: 101 }),
    bar(2, { open: 100 }),
    2,
    10_000,
    targetWinInput(),
  );
  assert("stop above/equal entry for long is rejected", badStop === null);

  const lastSignal = runBacktest({
    config: config({ endTs: ts(2) }),
    bars: [bar(0), bar(1)],
    features: [prevFeature(0), signalFeature(1)],
  });
  assert("last-bar signal is skipped", lastSignal.trades.length === 0);

  const acrossGap = captureError(() => runBacktest({
    ...targetWinInput(),
    bars: [bar(0), bar(1, { close: 104 }), bar(3, { open: 100, high: 113, low: 99, close: 112 })],
    features: [prevFeature(0), signalFeature(1)],
  }));
  assert("does not enter across a gap", acrossGap?.message.toLowerCase().includes("gap") === true, acrossGap?.message);

  const closedAtEnd = runBacktest(flatInput(true));
  assert("open position closes at final bar when configured", closedAtEnd.trades[0].reasonExited === "end_of_test");
  assert("end-of-test trade has exit timestamp", closedAtEnd.trades[0].exitTs === ts(4));

  const noExit = runBacktest(flatInput(false));
  assert("open position remains no_exit when configured", noExit.trades[0].reasonExited === "no_exit");
  assert("no_exit trade has null exit timestamp", noExit.trades[0].exitTs === null);

  const manySignals = runBacktest({
    config: config({ endTs: ts(6), closeOpenPositionAtEnd: false }),
    bars: [
      bar(0), bar(1, { close: 104 }), bar(2, { open: 100, high: 105, low: 97, close: 101 }),
      bar(3, { high: 106, low: 98, close: 102 }), bar(4, { high: 106, low: 98, close: 102 }), bar(5),
    ],
    features: [prevFeature(0), signalFeature(1), signalFeature(2, { macdHist: 0.7 }), signalFeature(3, { macdHist: 0.9 })],
  });
  assert("max concurrent positions = 1", manySignals.trades.length === 1);

  const news = runBacktest(targetWinInput({ regimes: [regime("NEWS_SHOCK", 1)] }));
  assert("NEWS_SHOCK regime blocks entries", news.trades.length === 0);

  const trend = runBacktest(targetWinInput({ regimes: [regime("TREND_UP", 0), regime("CHOP", 3)] }));
  assert("regime at entry is stamped", trend.trades[0].regimeAtEntry === "TREND_UP");
  const unknown = runBacktest(targetWinInput());
  assert("UNKNOWN regime is used when no regime exists", unknown.trades[0].regimeAtEntry === "UNKNOWN");
}

async function testMetricsAndStore(): Promise<void> {
  console.log("\n=== metrics and store ===");
  const win = runBacktest(targetWinInput({ regimes: [regime("TREND_UP", 0)] }));
  const loss = runBacktest(stopLossInput({ regimes: [regime("TREND_UP", 0)] }));
  const lossTrade = { ...loss.trades[0], regimeAtEntry: "CHOP" as const };
  const trades: SimulatedTrade[] = [win.trades[0], lossTrade, { ...lossTrade, entryTs: ts(5), entryHourUtc: 5, pnl: -25, regimeAtEntry: "CHOP" }];
  const equityCurve = [
    { ts: ts(0), equity: 10_000, drawdownPct: 0, openPositionMarketValue: 0 },
    { ts: ts(1), equity: 10_100, drawdownPct: 0, openPositionMarketValue: 1 },
    { ts: ts(2), equity: 9_900, drawdownPct: 1.9801980198019802, openPositionMarketValue: 0 },
    { ts: ts(3), equity: 10_050, drawdownPct: 0.49504950495049505, openPositionMarketValue: 0 },
  ];
  const metrics = calculateBacktestMetrics(config({ startTs: ts(0), endTs: ts(4) }), trades, equityCurve, [bar(0), bar(1), bar(2), bar(3)]);
  assert("metrics calculate total return", near(metrics.totalReturnPct, 0.5));
  assert("metrics calculate max drawdown", metrics.maxDrawdownPct > 1.9);
  assert("metrics calculate win rate", near(metrics.winRatePct, 100 / 3));
  assert("metrics calculate profit factor", metrics.profitFactor !== null && metrics.profitFactor > 0);
  assert("metrics calculate average winner", metrics.averageWinner !== null && metrics.averageWinner > 0);
  assert("metrics calculate average loser", metrics.averageLoser !== null && metrics.averageLoser < 0);
  assert("metrics calculate best trade", metrics.bestTradePnl === Math.max(...trades.map((t) => t.pnl)));
  assert("metrics calculate worst trade", metrics.worstTradePnl === Math.min(...trades.map((t) => t.pnl)));
  assert("metrics calculate max consecutive losses", metrics.maxConsecutiveLosses === 2);
  assert("metrics calculate exposure time", near(metrics.exposureTimePct, 25));
  assert("metrics calculate time-of-day performance", metrics.timeOfDayPerformance["05"].trades === 1);
  assert("metrics calculate regime performance", metrics.regimePerformance.CHOP.trades === 2);
  assert("Sharpe returns null when too few returns", calculateBacktestMetrics(config(), [], [equityCurve[0]], [bar(0)]).sharpeApprox === null);
  assert("Sortino returns null when too few returns", calculateBacktestMetrics(config(), [], [equityCurve[0]], [bar(0)]).sortinoApprox === null);
  assert("CAGR returns null for short windows", metrics.cagrPct === null);
  assert("metric notes explain short CAGR", metrics.notes.some((note) => note.includes("CAGR")));

  const zeroMetrics = calculateBacktestMetrics(config(), [], [equityCurve[0]], [bar(0)]);
  assert("zero trades expectancy is null", zeroMetrics.expectancy === null);
  assert("zero trades avgWin is null", zeroMetrics.avgWin === null);
  assert("zero trades avgLoss is null", zeroMetrics.avgLoss === null);
  assert("zero trades max winning streak is zero", zeroMetrics.maxWinningStreak === 0);
  assert("zero trades max losing streak is zero", zeroMetrics.maxLosingStreak === 0);

  const oneTradeMetrics = calculateBacktestMetrics(config({ startTs: ts(0), endTs: ts(4) }), [win.trades[0]], equityCurve, [bar(0), bar(1), bar(2), bar(3)]);
  assert("one trade avg duration bars is set", oneTradeMetrics.avgTradeDurationBars === win.trades[0].holdBars);
  assert("one trade median duration bars is set", oneTradeMetrics.medianTradeDurationBars === win.trades[0].holdBars);
  assert("one trade trade frequency is set", oneTradeMetrics.tradeFrequency !== null && oneTradeMetrics.tradeFrequency > 0);

  const allWinners = calculateBacktestMetrics(config({ startTs: ts(0), endTs: ts(4) }), [win.trades[0], { ...win.trades[0], entryTs: ts(3), exitTs: ts(3) }], equityCurve, [bar(0), bar(1), bar(2), bar(3)]);
  assert("all winners expectancy is positive", allWinners.expectancy !== null && allWinners.expectancy > 0);
  assert("all winners max winning streak is counted", allWinners.maxWinningStreak === 2);
  assert("all winners avgLoss is null", allWinners.avgLoss === null);

  const allLosers = calculateBacktestMetrics(config({ startTs: ts(0), endTs: ts(4) }), [loss.trades[0], lossTrade], equityCurve, [bar(0), bar(1), bar(2), bar(3)]);
  assert("all losers expectancy is negative", allLosers.expectancy !== null && allLosers.expectancy < 0);
  assert("all losers max losing streak is counted", allLosers.maxLosingStreak === 2);
  assert("all losers avgWin is null", allLosers.avgWin === null);

  assert("mixed outcomes avgLoss is positive magnitude", metrics.avgLoss !== null && metrics.avgLoss > 0);
  assert("mixed outcomes profit per bar is calculated", metrics.profitPerBar !== null);
  assert("mixed outcomes return-to-drawdown is calculated", metrics.returnToDrawdown !== null);

  const result = runBacktest(targetWinInput({ regimes: [regime("TREND_UP", 0)] }));
  const store = new InMemoryBacktestReportStore();
  const inserted = await store.insertRun(result);
  assert("InMemoryBacktestReportStore inserts run id", inserted.id === 1);
  assert("InMemoryBacktestReportStore inserts public id", inserted.publicId === "memory-1");
  assert("InMemoryBacktestReportStore inserts trades", await store.insertTrades(inserted.id, result.trades) === result.trades.length);
  const fetchedRun = await store.fetchRun("1");
  assert("InMemoryBacktestReportStore reads run by id", fetchedRun?.id === 1);
  const fetchedPublic = await store.fetchRun("memory-1");
  assert("InMemoryBacktestReportStore reads run by public id", fetchedPublic?.publicId === "memory-1");
  const fetchedTrades = await store.fetchTrades(1);
  assert("InMemoryBacktestReportStore reads trades", fetchedTrades.length === result.trades.length);
  assert("InMemoryBacktestReportStore preserves trade pnl", near(fetchedTrades[0].pnl, result.trades[0].pnl));
}

function testDeterminismAndPurity(): void {
  console.log("\n=== determinism and purity ===");
  const input = targetWinInput({ regimes: [regime("TREND_UP", 0)] });
  const beforeBars = JSON.stringify(input.bars);
  const beforeFeatures = JSON.stringify(input.features);
  const a = runBacktest(input);
  const b = runBacktest(input);
  assert("same input twice produces identical result JSON", JSON.stringify(a) === JSON.stringify(b));
  assert("engine does not mutate input bars", JSON.stringify(input.bars) === beforeBars);
  assert("engine does not mutate input features", JSON.stringify(input.features) === beforeFeatures);
  assert("entry slippage helper worsens long entry", applyEntrySlippage(100, "long", 10) > 100);
  assert("exit slippage helper worsens long exit", applyExitSlippage(100, "long", 10) < 100);
  assert("fee helper charges bps", near(feeForNotional(10_000, 10), 10));
  assert("result records config", a.config.strategyId === "momentum_continuation");
  assert("result records strategy version", a.strategyVersion === STRATEGY_VERSIONS.momentumContinuation);
  assert("result includes metrics notes", Array.isArray(a.metrics.notes));
}

function testResearchRoutingAndPortfolio(): void {
  console.log("\n=== research routing and portfolio ===");
  const routed = runBacktest({
    ...targetWinInput({ regimes: [regime("TREND_UP", 0)] }),
    config: config({ strategyId: "a6_regime_router", endTs: ts(5) }),
    strategyRouter: defaultA6RegimeRouter,
  });
  assert("A6 routed backtest can produce a trade", routed.trades.length === 1);
  assert("A6 routed trade records selected strategy", routed.trades[0].strategyId === "momentum_continuation" || routed.trades[0].strategyId === "breakout_expansion");

  const noTradeRoute = runBacktest({
    ...targetWinInput({ regimes: [regime("LOW_VOL", 0)] }),
    config: config({ strategyId: "a6_regime_router", endTs: ts(5) }),
    strategyRouter: defaultA6RegimeRouter,
  });
  assert("A6 routed no-signal regime can stay flat", noTradeRoute.trades.length === 0);

  const portfolio = runPortfolioBacktest(
    targetWinInput({ regimes: [regime("TREND_UP", 0)] }),
    { mode: "equal_weight", strategyIds: ["momentum_continuation"] },
  );
  assert("portfolio backtest returns metrics", portfolio.metrics.numberOfTrades === 1);
  assert("portfolio contribution is tracked", portfolio.strategyContribution[0].strategyId === "momentum_continuation");
  assert("portfolio attribution is keyed by strategy", portfolio.strategyAttribution.momentum_continuation.trades === 1);

  expectThrow("portfolio rejects leverage weights", () => runPortfolioBacktest(
    targetWinInput(),
    { mode: "custom_weight", strategyIds: ["momentum_continuation", "trend_pullback"], weights: { momentum_continuation: 0.8, trend_pullback: 0.8 } },
  ));

  const proxyBars = Array.from({ length: 96 }, (_, index) => {
    const cycle = index % 24;
    const trend = index < 32 ? index * 0.7 : index < 64 ? (64 - index) * 0.7 : Math.sin(index) * 2;
    const shock = cycle === 0 ? 12 : 0;
    const price = 100 + trend + shock;
    return bar(index, {
      open: price,
      high: price + (cycle === 0 ? 10 : cycle < 8 ? 4 : 1),
      low: price - (cycle === 0 ? 9 : cycle < 8 ? 4 : 1),
      close: price + (index < 32 ? 0.5 : index < 64 ? -0.5 : 0),
    });
  });
  const proxyFeatures = proxyBars.map((b, index) => feature(index, {
    close: b.close,
    atrPct: index % 24 === 0 ? 15 : index % 24 < 8 ? 5 : 0.4,
  }));
  const proxyRegimes = buildOhlcvProxyRegimes(proxyBars, proxyFeatures, 6);
  assert("OHLCV proxy emits one regime per bar", proxyRegimes.length === proxyBars.length);
  assert("OHLCV proxy labels are supported regimes", proxyRegimes.every((row) => REQUIRED_REGIMES.includes(row.regime)));
  const proxyValidation = runRegimeValidation({
    instrument: { symbol: "BTC-USD", exchange: "COINBASE", assetType: "CRYPTO", dataSource: "test" },
    baseConfig: {
      assetType: "CRYPTO",
      dataSource: "test",
      timeframe: "1h",
      featureVersion: "features.test.v1",
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
    },
    bars: proxyBars,
    features: proxyFeatures,
    regimes: proxyRegimes,
    regimeSource: "ohlcv_proxy",
    strategyIds: ["momentum_continuation"],
    windowsPerRegime: 1,
    windowBars: 4,
    minDominantRegimePct: 25,
  });
  assert("OHLCV proxy validation can select windows", proxyValidation.selectedWindows.length > 0);
}

async function main(): Promise<void> {
  testValidation();
  testSimulation();
  await testMetricsAndStore();
  testResearchRoutingAndPortfolio();
  testDeterminismAndPurity();

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`} (${passed} passed)`);
  if (passed < 100) {
    console.log(`FAIL: expected at least 100 assertions, got ${passed}`);
    failed++;
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
