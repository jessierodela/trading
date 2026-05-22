import type {
  Bar,
  FeatureSnapshot,
  RegimeContext,
  RegimeLabel,
  StrategySignal,
  Timeframe,
} from "@/lib/quant/types";
import { getStrategyById } from "@/lib/strategies/strategyRegistry";
import { applyEntrySlippage, applyExitSlippage, feeForNotional } from "./slippage";
import { calculateBacktestMetrics } from "./metrics";
import type {
  BacktestInput,
  BacktestResult,
  EquityPoint,
  SimulatedTrade,
  TradeExitReason,
} from "./types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": HOUR_MS,
  "1d": DAY_MS,
};

interface OpenPosition {
  signal: StrategySignal;
  direction: "long" | "short";
  entryIndex: number;
  signalTs: string;
  entryTs: string;
  rawEntryPrice: number;
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number | null;
  entryFee: number;
  entrySlippageCost: number;
  regimeAtEntry: RegimeLabel | "UNKNOWN";
}

function assertFinitePositive(label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
}

function assertNonNegative(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`);
}

function assertAscendingUnique<T extends { ts: string }>(label: string, rows: T[]): void {
  const seen = new Set<string>();
  let prev: string | null = null;
  for (const row of rows) {
    if (seen.has(row.ts)) throw new Error(`${label} has duplicate timestamp ${row.ts}`);
    seen.add(row.ts);
    if (prev !== null && row.ts <= prev) throw new Error(`${label} must be ascending by ts`);
    prev = row.ts;
  }
}

function assertContiguous<T extends { ts: string }>(
  label: string,
  rows: T[],
  timeframe: Timeframe,
): void {
  const expectedMs = TIMEFRAME_MS[timeframe];
  for (let i = 1; i < rows.length; i++) {
    const prevMs = Date.parse(rows[i - 1].ts);
    const curMs = Date.parse(rows[i].ts);
    if (curMs - prevMs !== expectedMs) {
      throw new Error(
        `${label} gap detected: missing interval between ${rows[i - 1].ts} and ${rows[i].ts} ` +
        `for timeframe ${timeframe}`,
      );
    }
  }
}

function validateInputs(input: BacktestInput): void {
  const { config, bars, features } = input;
  if (Date.parse(config.endTs) <= Date.parse(config.startTs)) throw new Error("endTs must be greater than startTs");
  assertFinitePositive("initialCapital", config.initialCapital);
  assertFinitePositive("riskPerTradePct", config.riskPerTradePct);
  assertFinitePositive("maxPositionPct", config.maxPositionPct);
  assertNonNegative("feeBps", config.feeBps);
  assertNonNegative("slippageBps", config.slippageBps);
  if (config.maxConcurrentPositions !== 1) throw new Error("maxConcurrentPositions must be 1 in v1");
  if (config.enterOnNextBarOpen !== true) throw new Error("enterOnNextBarOpen must be true in v1");
  if (config.sameBarStopFirst !== true) throw new Error("sameBarStopFirst must be true in v1");
  if (bars.length === 0) throw new Error("bars are required");
  if (features.length === 0) throw new Error("features are required");

  assertAscendingUnique("bars", bars);
  assertAscendingUnique("features", features);
  assertContiguous("bars", bars, config.timeframe);
  assertContiguous("features", features, config.timeframe);

  const barTs = new Set(bars.map((b) => b.ts));
  for (const bar of bars) {
    if (bar.symbol !== config.symbol || bar.exchange !== config.exchange || bar.timeframe !== config.timeframe) {
      throw new Error("bars must match config symbol/exchange/timeframe");
    }
  }
  for (const feature of features) {
    if (feature.symbol !== config.symbol || feature.exchange !== config.exchange || feature.timeframe !== config.timeframe) {
      throw new Error("features must match config symbol/exchange/timeframe");
    }
    if (feature.featureVersion !== config.featureVersion) {
      throw new Error("features must match config featureVersion");
    }
    if (!barTs.has(feature.ts)) throw new Error(`feature timestamp has no matching bar: ${feature.ts}`);
  }
  if (input.dailyFeatures) {
    for (const daily of input.dailyFeatures) {
      if (daily.symbol !== config.symbol || daily.exchange !== config.exchange || daily.timeframe !== "1d") {
        throw new Error("dailyFeatures must match symbol/exchange and use 1d timeframe");
      }
    }
  }
}

function latestRegimeAtOrBefore(
  regimes: RegimeContext[] | undefined,
  ts: string,
): RegimeContext | null {
  if (!regimes || regimes.length === 0) return null;
  const sorted = [...regimes].sort((a, b) => a.ts.localeCompare(b.ts));
  let latest: RegimeContext | null = null;
  for (const regime of sorted) {
    if (regime.ts <= ts) latest = regime;
    if (regime.ts > ts) break;
  }
  return latest;
}

function latestClosedDailyFor(
  dailyFeatures: FeatureSnapshot[] | undefined,
  current: FeatureSnapshot,
): FeatureSnapshot | null {
  if (!dailyFeatures || dailyFeatures.length === 0) return null;
  const sorted = [...dailyFeatures].sort((a, b) => a.ts.localeCompare(b.ts));
  const currentMs = Date.parse(current.ts);
  let latest: FeatureSnapshot | null = null;
  for (const candidate of sorted) {
    const openMs = Date.parse(candidate.ts);
    if (candidate.symbol !== current.symbol || candidate.exchange !== current.exchange || candidate.timeframe !== "1d") continue;
    if (openMs + DAY_MS <= currentMs) latest = candidate;
    if (openMs > currentMs) break;
  }
  return latest;
}

function closePosition(
  position: OpenPosition,
  rawExitPrice: number,
  exitTs: string,
  exitIndex: number,
  reasonExited: TradeExitReason,
  feeBps: number,
  slippageBps: number,
): SimulatedTrade {
  const exitPrice = applyExitSlippage(rawExitPrice, position.direction, slippageBps);
  const exitFee = feeForNotional(exitPrice * position.quantity, feeBps);
  const grossPnl = position.direction === "long"
    ? (exitPrice - position.entryPrice) * position.quantity
    : (position.entryPrice - exitPrice) * position.quantity;
  const fees = position.entryFee + exitFee;
  const exitSlippageCost = position.direction === "long"
    ? Math.max(0, rawExitPrice - exitPrice) * position.quantity
    : Math.max(0, exitPrice - rawExitPrice) * position.quantity;
  const pnl = grossPnl - fees;
  const entryNotional = position.entryPrice * position.quantity;
  const holdBars = Math.max(1, exitIndex - position.entryIndex + 1);
  const holdHours = Math.max(0, (Date.parse(exitTs) - Date.parse(position.entryTs)) / HOUR_MS);

  return {
    symbol: position.signal.symbol,
    exchange: position.signal.exchange,
    direction: position.direction,
    strategyId: position.signal.strategyId,
    strategyVersion: position.signal.strategyVersion,
    featureVersion: position.signal.featureVersion,
    signalTs: position.signalTs,
    entryTs: position.entryTs,
    entryPrice: position.entryPrice,
    exitTs,
    exitPrice,
    quantity: position.quantity,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
    grossPnl,
    fees,
    slippageCost: position.entrySlippageCost + exitSlippageCost,
    pnl,
    pnlPct: entryNotional === 0 ? 0 : pnl / entryNotional * 100,
    reasonEntered: position.signal.reasons.join("; "),
    reasonExited,
    holdBars,
    holdHours,
    regimeAtEntry: position.regimeAtEntry,
    entryHourUtc: new Date(position.entryTs).getUTCHours(),
    sourceSignal: position.signal,
  };
}

function noExitTrade(position: OpenPosition, finalIndex: number): SimulatedTrade {
  const entryNotional = position.entryPrice * position.quantity;
  return {
    symbol: position.signal.symbol,
    exchange: position.signal.exchange,
    direction: position.direction,
    strategyId: position.signal.strategyId,
    strategyVersion: position.signal.strategyVersion,
    featureVersion: position.signal.featureVersion,
    signalTs: position.signalTs,
    entryTs: position.entryTs,
    entryPrice: position.entryPrice,
    exitTs: null,
    exitPrice: null,
    quantity: position.quantity,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
    grossPnl: 0,
    fees: position.entryFee,
    slippageCost: position.entrySlippageCost,
    pnl: -position.entryFee,
    pnlPct: entryNotional === 0 ? 0 : -position.entryFee / entryNotional * 100,
    reasonEntered: position.signal.reasons.join("; "),
    reasonExited: "no_exit",
    holdBars: Math.max(1, finalIndex - position.entryIndex + 1),
    holdHours: 0,
    regimeAtEntry: position.regimeAtEntry,
    entryHourUtc: new Date(position.entryTs).getUTCHours(),
    sourceSignal: position.signal,
  };
}

export function createOpenPositionFromSignal(
  signal: StrategySignal,
  entryBar: Bar,
  entryIndex: number,
  equity: number,
  input: BacktestInput,
): OpenPosition | null {
  const { config } = input;
  if (signal.signalType !== "trigger") return null;
  if (signal.direction === "none") return null;
  if (signal.direction === "short" && config.allowShorts !== true) return null;

  const direction = signal.direction;
  const stopLoss = signal.stopLoss ?? signal.invalidationPrice ?? null;
  if (stopLoss === null || !Number.isFinite(stopLoss)) return null;

  const entryPrice = applyEntrySlippage(entryBar.open, direction, config.slippageBps);
  const riskPerUnit = direction === "long" ? entryPrice - stopLoss : stopLoss - entryPrice;
  if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0) return null;

  const rewardRisk = config.defaultRewardRisk ?? 2;
  const takeProfit = signal.takeProfit ?? (
    direction === "long"
      ? entryPrice + riskPerUnit * rewardRisk
      : entryPrice - riskPerUnit * rewardRisk
  );

  const riskUsd = equity * config.riskPerTradePct;
  const quantityByRisk = riskUsd / riskPerUnit;
  const quantityByMaxNotional = equity * config.maxPositionPct / entryPrice;
  const quantity = Math.min(quantityByRisk, quantityByMaxNotional);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;

  const entryFee = feeForNotional(entryPrice * quantity, config.feeBps);
  const entrySlippageCost = direction === "long"
    ? Math.max(0, entryPrice - entryBar.open) * quantity
    : Math.max(0, entryBar.open - entryPrice) * quantity;
  const entryRegime = latestRegimeAtOrBefore(input.regimes, entryBar.ts);

  return {
    signal,
    direction,
    entryIndex,
    signalTs: signal.ts,
    entryTs: entryBar.ts,
    rawEntryPrice: entryBar.open,
    entryPrice,
    quantity,
    stopLoss,
    takeProfit,
    entryFee,
    entrySlippageCost,
    regimeAtEntry: entryRegime?.regime ?? "UNKNOWN",
  };
}

function maybeExitOnBar(
  position: OpenPosition,
  bar: Bar,
  index: number,
  input: BacktestInput,
): SimulatedTrade | null {
  if (position.direction === "long") {
    const stopHit = bar.low <= position.stopLoss;
    const targetHit = position.takeProfit !== null && bar.high >= position.takeProfit;
    if (stopHit) return closePosition(position, position.stopLoss, bar.ts, index, "stop_loss", input.config.feeBps, input.config.slippageBps);
    if (targetHit) return closePosition(position, position.takeProfit!, bar.ts, index, "take_profit", input.config.feeBps, input.config.slippageBps);
  } else {
    const stopHit = bar.high >= position.stopLoss;
    const targetHit = position.takeProfit !== null && bar.low <= position.takeProfit;
    if (stopHit) return closePosition(position, position.stopLoss, bar.ts, index, "stop_loss", input.config.feeBps, input.config.slippageBps);
    if (targetHit) return closePosition(position, position.takeProfit!, bar.ts, index, "take_profit", input.config.feeBps, input.config.slippageBps);
  }

  const isFinalBar = index === input.bars.length - 1;
  if (isFinalBar && input.config.closeOpenPositionAtEnd) {
    return closePosition(position, bar.close, bar.ts, index, "end_of_test", input.config.feeBps, input.config.slippageBps);
  }
  return null;
}

function markToMarket(position: OpenPosition | null, bar: Bar): { equityDelta: number; marketValue: number } {
  if (!position) return { equityDelta: 0, marketValue: 0 };
  const gross = position.direction === "long"
    ? (bar.close - position.entryPrice) * position.quantity
    : (position.entryPrice - bar.close) * position.quantity;
  return {
    equityDelta: gross - position.entryFee,
    marketValue: Math.abs(bar.close * position.quantity),
  };
}

export function runBacktest(input: BacktestInput): BacktestResult {
  validateInputs(input);
  const { config, bars, features } = input;
  const strategy = input.strategyRouter ?? getStrategyById(config.strategyId);
  if (!strategy) throw new Error(`unknown strategyId: ${config.strategyId}`);

  const barIndexByTs = new Map(bars.map((bar, index) => [bar.ts, index]));
  const featureByTs = new Map(features.map((feature) => [feature.ts, feature]));
  const trades: SimulatedTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  let equity = config.initialCapital;
  let peakEquity = config.initialCapital;
  let open: OpenPosition | null = null;

  for (let barIndex = 0; barIndex < bars.length; barIndex++) {
    const bar = bars[barIndex];

    if (open && open.entryIndex <= barIndex) {
      const closed = maybeExitOnBar(open, bar, barIndex, input);
      if (closed) {
        trades.push(closed);
        equity += closed.pnl;
        open = null;
      }
    }

    const mtm = markToMarket(open && open.entryIndex <= barIndex ? open : null, bar);
    const currentEquity = equity + mtm.equityDelta;
    peakEquity = Math.max(peakEquity, currentEquity);
    equityCurve.push({
      ts: bar.ts,
      equity: currentEquity,
      drawdownPct: peakEquity === 0 ? 0 : (peakEquity - currentEquity) / peakEquity * 100,
      openPositionMarketValue: mtm.marketValue,
    });

    const feature = featureByTs.get(bar.ts);
    if (!feature || open) continue;
    const featureIndex = features.findIndex((f) => f.ts === feature.ts);
    const nextBarIndex = barIndexByTs.get(feature.ts)! + 1;
    if (nextBarIndex >= bars.length) continue;

    const regime = latestRegimeAtOrBefore(input.regimes, feature.ts);
    const signal = strategy.evaluate({
      current: feature,
      previous: featureIndex > 0 ? features[featureIndex - 1] : undefined,
      recent: features.slice(Math.max(0, featureIndex - 50), featureIndex + 1),
      daily: latestClosedDailyFor(input.dailyFeatures, feature),
      regime,
    });
    if (!signal || signal.signalType !== "trigger") continue;
    if (!input.strategyRouter && regime?.regime === "NEWS_SHOCK") continue;

    open = createOpenPositionFromSignal(signal, bars[nextBarIndex], nextBarIndex, equity, input);
  }

  if (open && !config.closeOpenPositionAtEnd) {
    trades.push(noExitTrade(open, bars.length - 1));
  }

  const metrics = calculateBacktestMetrics(config, trades, equityCurve, bars);
  return {
    config,
    strategyVersion: strategy.version,
    trades,
    equityCurve,
    metrics,
  };
}
