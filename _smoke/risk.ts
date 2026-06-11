import { evaluateKillSwitch } from "@/lib/risk/killSwitch";
import { evaluateRisk } from "@/lib/risk/riskEngine";
import { calculatePositionSize } from "@/lib/risk/positionSizing";
import { calculateStopLoss, calculateTakeProfit } from "@/lib/risk/stops";
import type {
  Position,
  PnlSnapshot,
  RiskConfig,
  RiskInput,
  StrategySignal,
} from "@/lib/risk/types";

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`PASS: ${name}`);
    passed++;
  } else {
    console.error(`FAIL: ${name}`, detail ?? "");
    failed++;
  }
}

function near(actual: number, expected: number, epsilon = 1e-9): boolean {
  return Math.abs(actual - expected) <= epsilon;
}

function config(overrides: Partial<RiskConfig> = {}): RiskConfig {
  return {
    enabled: true,
    maxRiskPerTradePct: 0.01,
    maxDailyLossPct: 0.02,
    maxWeeklyLossPct: 0.05,
    maxOpenPositions: 5,
    maxSymbolExposurePct: 0.5,
    maxPortfolioExposurePct: 1,
    minRegimeReliability: 0.5,
    blockedRegimes: [],
    allowLong: true,
    allowShort: true,
    defaultStopLossPct: 0.02,
    defaultTakeProfitPct: 0.04,
    maxLeverage: 1,
    staleSignalMaxAgeMs: 5 * 60 * 1000,
    duplicateCooldownMs: 10 * 60 * 1000,
    maxConsecutiveLosses: 3,
    highVolSizeMultiplier: 0.5,
    chopSizeMultiplier: 0.25,
    newsShockBlocksTrading: true,
    killSwitchEnabled: false,
    ...overrides,
  };
}

function signal(overrides: Partial<StrategySignal> = {}): StrategySignal {
  const direction = overrides.direction ?? "long";
  return {
    symbol: "BTC-USD",
    exchange: "COINBASE",
    timeframe: "1h",
    ts: "2026-06-11T12:00:00.000Z",
    strategyId: "risk_smoke",
    signalType: "trigger",
    direction,
    confidence: 0.8,
    invalidationPrice: direction === "short" ? 105 : 95,
    stopLoss: null,
    takeProfit: direction === "short" ? 90 : 110,
    features: {
      symbol: "BTC-USD",
      exchange: "COINBASE",
      timeframe: "1h",
      ts: "2026-06-11T12:00:00.000Z",
      close: 100,
      featureVersion: "features.test.v1",
    },
    reasons: ["risk smoke signal"],
    strategyVersion: "strategy.test.v1",
    featureVersion: "features.test.v1",
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    symbol: "ETH-USD",
    side: "LONG",
    quantity: 1,
    entryPrice: 100,
    markPrice: 100,
    openedAt: "2026-06-11T10:00:00.000Z",
    unrealizedPnl: 0,
    ...overrides,
  };
}

function pnl(overrides: Partial<PnlSnapshot> = {}): PnlSnapshot {
  return {
    ts: "2026-06-11T11:00:00.000Z",
    realizedPnl: 0,
    unrealizedPnl: 0,
    equity: 10_000,
    consecutiveLosses: 0,
    ...overrides,
  };
}

function input(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    signal: signal(),
    regime: { regime: "TREND_UP", reliability: 0.9, ts: "2026-06-11T12:00:00.000Z" },
    accountEquity: 10_000,
    openPositions: [],
    recentPnL: [],
    config: config(),
    nowTs: "2026-06-11T12:01:00.000Z",
    ...overrides,
  };
}

function testApprovalsAndStops(): void {
  console.log("\n=== approvals and stops ===");
  const long = evaluateRisk(input());
  assert("approves normal valid long trade", long.approved, long);
  assert("long stop prefers invalidation", long.stopLoss === 95, long.stopLoss);
  assert("long target prefers signal target", long.takeProfit === 110, long.takeProfit);

  const shortSignal = signal({ direction: "short", invalidationPrice: 105, takeProfit: 90 });
  const short = evaluateRisk(input({ signal: shortSignal }));
  assert("approves normal valid short trade when short allowed", short.approved, short);
  assert("short stop remains above entry", short.stopLoss === 105, short.stopLoss);

  const defaultSignal = signal({ invalidationPrice: null, stopLoss: null, takeProfit: null });
  const defaultInput = input({ signal: defaultSignal });
  assert("default long stop is percent based", near(calculateStopLoss({ signal: defaultSignal, side: "LONG", entryPrice: 100, config: defaultInput.config })!, 98));
  assert("default long target is percent based", near(calculateTakeProfit({ signal: defaultSignal, side: "LONG", entryPrice: 100, config: defaultInput.config })!, 104));

  const defaultShortSignal = signal({ direction: "short", invalidationPrice: null, stopLoss: null, takeProfit: null });
  assert("default short stop is percent based", near(calculateStopLoss({ signal: defaultShortSignal, side: "SHORT", entryPrice: 100, config: defaultInput.config })!, 102));
  assert("default short target is percent based", near(calculateTakeProfit({ signal: defaultShortSignal, side: "SHORT", entryPrice: 100, config: defaultInput.config })!, 96));
}

function testCoreBlocks(): void {
  console.log("\n=== core blocks ===");
  assert("blocks low equity", evaluateRisk(input({ accountEquity: 0 })).blockedBy.includes("ACCOUNT_EQUITY_INVALID"));

  const noStopSignal = signal({ invalidationPrice: null, stopLoss: null });
  const noStop = evaluateRisk(input({ signal: noStopSignal, config: config({ defaultStopLossPct: 0 }) }));
  assert("blocks missing stop/invalidation", noStop.blockedBy.includes("STOP_LOSS_MISSING"), noStop);

  const stale = evaluateRisk(input({ nowTs: "2026-06-11T13:00:00.000Z" }));
  assert("blocks stale signal", stale.blockedBy.includes("SIGNAL_STALE"), stale);

  const duplicate = evaluateRisk(input({
    openPositions: [position({ symbol: "BTC-USD", side: "LONG", openedAt: "2026-06-11T11:55:00.000Z" })],
  }));
  assert("blocks duplicate same-direction cooldown", duplicate.blockedBy.includes("DUPLICATE_COOLDOWN"), duplicate);

  const maxOpen = evaluateRisk(input({
    config: config({ maxOpenPositions: 1 }),
    openPositions: [position()],
  }));
  assert("blocks max open positions", maxOpen.blockedBy.includes("MAX_OPEN_POSITIONS"), maxOpen);

  const blockedRegime = evaluateRisk(input({
    config: config({ blockedRegimes: ["TREND_UP"] }),
  }));
  assert("blocks configured regime", blockedRegime.blockedBy.includes("REGIME_BLOCKED"), blockedRegime);

  const news = evaluateRisk(input({
    regime: { regime: "NEWS_SHOCK", reliability: 0.9, ts: "2026-06-11T12:00:00.000Z" },
  }));
  assert("blocks NEWS_SHOCK", news.blockedBy.includes("NEWS_SHOCK_BLOCKED"), news);

  const lowReliability = evaluateRisk(input({
    regime: { regime: "TREND_UP", reliability: 0.3, ts: "2026-06-11T12:00:00.000Z" },
  }));
  assert("blocks low regime reliability", lowReliability.blockedBy.includes("REGIME_RELIABILITY_LOW"), lowReliability);

  const noTrade = evaluateRisk(input({ signal: signal({ direction: "none" }) }));
  assert("blocks no-trade signal direction", noTrade.blockedBy.includes("NO_TRADE_SIGNAL"), noTrade);

  const missingEntry = signal();
  missingEntry.features = { ...missingEntry.features, close: Number.NaN };
  assert("blocks missing entry price", evaluateRisk(input({ signal: missingEntry })).blockedBy.includes("ENTRY_PRICE_MISSING"));
}

function testRegimeSizing(): void {
  console.log("\n=== regime sizing ===");
  const normal = evaluateRisk(input());
  const highVol = evaluateRisk(input({
    regime: { regime: "HIGH_VOL", reliability: 0.9, ts: "2026-06-11T12:00:00.000Z" },
  }));
  assert("reduces size in HIGH_VOL", highVol.approved && near(highVol.positionSize, normal.positionSize * 0.5), highVol);
  assert("HIGH_VOL warning is present", highVol.warnings.includes("HIGH_VOL_SIZE_REDUCED"), highVol.warnings);

  const chop = evaluateRisk(input({
    regime: { regime: "CHOP", reliability: 0.9, ts: "2026-06-11T12:00:00.000Z" },
  }));
  assert("reduces size in CHOP", chop.approved && near(chop.positionSize, normal.positionSize * 0.25), chop);

  const blockedChop = evaluateRisk(input({
    config: config({ chopSizeMultiplier: 0 }),
    regime: { regime: "CHOP", reliability: 0.9, ts: "2026-06-11T12:00:00.000Z" },
  }));
  assert("blocks CHOP when multiplier is zero", blockedChop.blockedBy.includes("REGIME_SIZE_BLOCKED"), blockedChop);
}

function testLossAndDirectionBlocks(): void {
  console.log("\n=== losses and direction blocks ===");
  const daily = evaluateRisk(input({ recentPnL: [pnl({ realizedPnl: -250 })] }));
  assert("blocks max daily loss", daily.blockedBy.includes("MAX_DAILY_LOSS"), daily);

  const weekly = evaluateRisk(input({
    config: config({ maxDailyLossPct: 0.5, maxWeeklyLossPct: 0.05 }),
    recentPnL: [pnl({ ts: "2026-06-09T11:00:00.000Z", realizedPnl: -600 })],
  }));
  assert("blocks max weekly loss", weekly.blockedBy.includes("MAX_WEEKLY_LOSS"), weekly);

  const consecutive = evaluateRisk(input({ recentPnL: [pnl({ consecutiveLosses: 3 })] }));
  assert("blocks max consecutive losses", consecutive.blockedBy.includes("MAX_CONSECUTIVE_LOSSES"), consecutive);

  const longBlocked = evaluateRisk(input({ config: config({ allowLong: false }) }));
  assert("blocks long when allowLong=false", longBlocked.blockedBy.includes("LONG_NOT_ALLOWED"), longBlocked);

  const shortBlocked = evaluateRisk(input({
    signal: signal({ direction: "short", invalidationPrice: 105, takeProfit: 90 }),
    config: config({ allowShort: false }),
  }));
  assert("blocks short when allowShort=false", shortBlocked.blockedBy.includes("SHORT_NOT_ALLOWED"), shortBlocked);
}

function testPositionSizingAndExposure(): void {
  console.log("\n=== position sizing and exposure ===");
  const sized = evaluateRisk(input());
  assert("sizes position based on max risk per trade", near(sized.positionSize, 20), sized);
  assert("reports max risk per trade", near(sized.maxRiskUsd, 100), sized.maxRiskUsd);

  const symbolCapped = evaluateRisk(input({
    config: config({ maxSymbolExposurePct: 0.1, duplicateCooldownMs: 0 }),
    openPositions: [position({ symbol: "BTC-USD", quantity: 9, entryPrice: 100, markPrice: 100 })],
  }));
  assert("caps exposure by symbol limit", symbolCapped.approved && near(symbolCapped.positionSize, 1), symbolCapped);

  const portfolioCapped = evaluateRisk(input({
    config: config({ maxSymbolExposurePct: 1, maxPortfolioExposurePct: 1 }),
    openPositions: [position({ symbol: "ETH-USD", quantity: 90, entryPrice: 100, markPrice: 100 })],
  }));
  assert("caps exposure by portfolio limit", portfolioCapped.approved && near(portfolioCapped.positionSize, 10), portfolioCapped);

  const leverageCapped = evaluateRisk(input({
    config: config({ maxSymbolExposurePct: 1, maxPortfolioExposurePct: 2, maxLeverage: 0.5 }),
    openPositions: [position({ symbol: "ETH-USD", quantity: 40, entryPrice: 100, markPrice: 100 })],
  }));
  assert("caps exposure by leverage limit", leverageCapped.approved && near(leverageCapped.positionSize, 10), leverageCapped);

  const direct = calculatePositionSize({
    accountEquity: 10_000,
    symbol: "BTC-USD",
    entryPrice: 100,
    stopLoss: 100,
    openPositions: [],
    config: config(),
    sizeMultiplier: 1,
  });
  assert("position size is zero when risk per unit is invalid", direct.positionSize === 0, direct);

  const symbolFull = evaluateRisk(input({
    config: config({ maxSymbolExposurePct: 0.1, duplicateCooldownMs: 0 }),
    openPositions: [position({ symbol: "BTC-USD", quantity: 10, markPrice: 100 })],
  }));
  assert("blocks when symbol exposure is already full", symbolFull.blockedBy.includes("MAX_SYMBOL_EXPOSURE"), symbolFull);
}

function testKillSwitchAndDisabledMode(): void {
  console.log("\n=== kill switch and disabled mode ===");
  const manual = evaluateRisk(input({ config: config({ killSwitchEnabled: true }) }));
  assert("kill switch blocks trading", manual.blockedBy.includes("KILL_SWITCH_ENABLED"), manual);

  const drawdownInput = input({
    config: config({ maxOpenPositionDrawdownPct: 0.1 }),
    openPositions: [position({ quantity: 10, entryPrice: 100, markPrice: 80, unrealizedPnl: -200 })],
  });
  const drawdownKill = evaluateKillSwitch({
    accountEquity: drawdownInput.accountEquity,
    openPositions: drawdownInput.openPositions,
    recentPnL: drawdownInput.recentPnL,
    regime: drawdownInput.regime,
    config: drawdownInput.config,
    nowTs: drawdownInput.nowTs!,
  });
  assert("kill switch detects open position drawdown", drawdownKill.blockedBy.includes("MAX_OPEN_POSITION_DRAWDOWN"), drawdownKill);

  const disabled = evaluateRisk(input({
    accountEquity: 0,
    signal: signal({ direction: "none", invalidationPrice: null, stopLoss: null }),
    config: config({ enabled: false }),
  }));
  assert("risk disabled returns pass-through approval", disabled.approved, disabled);
  assert("risk disabled returns pass-through warning", disabled.warnings.includes("RISK_ENGINE_DISABLED"), disabled);
}

function testDeterminism(): void {
  console.log("\n=== determinism ===");
  const riskInput = input({ recentPnL: [pnl()] });
  const before = JSON.stringify(riskInput);
  const first = evaluateRisk(riskInput);
  const second = evaluateRisk(riskInput);
  assert("same risk input produces identical decision", JSON.stringify(first) === JSON.stringify(second));
  assert("risk engine does not mutate input", JSON.stringify(riskInput) === before);
}

function main(): void {
  testApprovalsAndStops();
  testCoreBlocks();
  testRegimeSizing();
  testLossAndDirectionBlocks();
  testPositionSizingAndExposure();
  testKillSwitchAndDisabledMode();
  testDeterminism();

  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`} (${passed} passed)`);
  if (failed > 0) process.exit(1);
}

main();
