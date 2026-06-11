import type { RiskConfig, RiskPositionSide, StrategySignal } from "./types";

interface StopTargetInput {
  signal: StrategySignal;
  side: RiskPositionSide;
  entryPrice: number;
  config: RiskConfig;
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isValidStop(side: RiskPositionSide, entryPrice: number, stopLoss: number): boolean {
  return side === "LONG" ? stopLoss < entryPrice : stopLoss > entryPrice;
}

function isValidTarget(side: RiskPositionSide, entryPrice: number, takeProfit: number): boolean {
  return side === "LONG" ? takeProfit > entryPrice : takeProfit < entryPrice;
}

export function calculateStopLoss(input: StopTargetInput): number | null {
  const { signal, side, entryPrice, config } = input;
  if (!isPositiveFinite(entryPrice)) return null;

  const supplied = signal.invalidationPrice ?? signal.stopLoss;
  if (supplied !== null && supplied !== undefined) {
    return isPositiveFinite(supplied) && isValidStop(side, entryPrice, supplied) ? supplied : null;
  }

  if (!config.allowDefaultStopFallback) return null;
  if (!Number.isFinite(config.defaultStopLossPct) || config.defaultStopLossPct <= 0) return null;
  const stopLoss = side === "LONG"
    ? entryPrice * (1 - config.defaultStopLossPct)
    : entryPrice * (1 + config.defaultStopLossPct);
  return isPositiveFinite(stopLoss) && isValidStop(side, entryPrice, stopLoss) ? stopLoss : null;
}

export function calculateTakeProfit(input: StopTargetInput): number | null {
  const { signal, side, entryPrice, config } = input;
  if (!isPositiveFinite(entryPrice)) return null;

  if (signal.takeProfit !== null && signal.takeProfit !== undefined) {
    return isPositiveFinite(signal.takeProfit) && isValidTarget(side, entryPrice, signal.takeProfit)
      ? signal.takeProfit
      : null;
  }

  if (!Number.isFinite(config.defaultTakeProfitPct) || config.defaultTakeProfitPct <= 0) return null;
  const takeProfit = side === "LONG"
    ? entryPrice * (1 + config.defaultTakeProfitPct)
    : entryPrice * (1 - config.defaultTakeProfitPct);
  return isPositiveFinite(takeProfit) && isValidTarget(side, entryPrice, takeProfit) ? takeProfit : null;
}
