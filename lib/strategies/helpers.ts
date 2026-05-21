import type {
  Direction,
  FeatureSnapshot,
  RegimeContext,
  StrategySignal,
  StrategySignalType,
} from "@/lib/quant/types";

export function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

export function hasRequiredNumbers(
  feature: FeatureSnapshot,
  keys: Array<keyof FeatureSnapshot>,
): boolean {
  return keys.every((key) => isFiniteNumber(feature[key]));
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function confidenceFromScore(score: number, max: number): number {
  if (max <= 0) return 0;
  return clamp01(score / max);
}

export function atrStopBelow(
  current: FeatureSnapshot,
  atrMultiple: number,
): number | null {
  if (!isFiniteNumber(current.close) || !isFiniteNumber(current.atr14)) return null;
  return current.close - current.atr14 * atrMultiple;
}

export function isBlockedRegime(
  regime: RegimeContext | null | undefined,
): boolean {
  return regime?.regime === "NEWS_SHOCK";
}

export function isChop(
  regime: RegimeContext | null | undefined,
): boolean {
  return regime?.regime === "CHOP";
}

export function isTrendUp(
  regime: RegimeContext | null | undefined,
): boolean {
  return regime?.regime === "TREND_UP";
}

export function isTrendDownReliable(
  regime: RegimeContext | null | undefined,
  minReliability = 0.7,
): boolean {
  return regime?.regime === "TREND_DOWN" && regime.reliability >= minReliability;
}

export function hasFeatureVersion(current: FeatureSnapshot): boolean {
  return typeof current.featureVersion === "string" && current.featureVersion.length > 0;
}

export function roundedConfidence(value: number): number {
  return Math.round(clamp01(value) * 100) / 100;
}

export function makeSignal(args: {
  current: FeatureSnapshot;
  strategyId: string;
  strategyVersion: string;
  signalType: StrategySignalType;
  direction: Direction;
  confidence: number;
  reasons: string[];
  invalidationPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  expectedEdge?: number | null;
}): StrategySignal {
  return {
    symbol: args.current.symbol,
    exchange: args.current.exchange,
    timeframe: args.current.timeframe,
    ts: args.current.ts,
    strategyId: args.strategyId,
    signalType: args.signalType,
    direction: args.direction,
    confidence: roundedConfidence(args.confidence),
    expectedEdge: args.expectedEdge ?? null,
    invalidationPrice: args.invalidationPrice ?? null,
    stopLoss: args.stopLoss ?? null,
    takeProfit: args.takeProfit ?? null,
    features: args.current,
    reasons: args.reasons,
    strategyVersion: args.strategyVersion,
    featureVersion: args.current.featureVersion,
  };
}

