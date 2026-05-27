import { breakoutExpansion } from "./breakoutExpansion";
import { meanReversionBounce } from "./meanReversionBounce";
import { momentumContinuation } from "./momentumContinuation";
import { REFINED_STRATEGY_VARIANTS } from "./refinement/strategyVariants";
import { trendPullback } from "./trendPullback";
import type { StrategyDefinition, StrategyInput } from "./types";
import type { StrategySignal } from "@/lib/quant/types";

export const STRATEGY_REGISTRY = [
  momentumContinuation,
  trendPullback,
  breakoutExpansion,
  meanReversionBounce,
  ...REFINED_STRATEGY_VARIANTS,
] as const satisfies readonly StrategyDefinition[];

export function runStrategies(input: StrategyInput): StrategySignal[] {
  return STRATEGY_REGISTRY
    .map((strategy) => strategy.evaluate(input))
    .filter((x): x is StrategySignal => x !== null);
}

export function getStrategyById(id: string): StrategyDefinition | null {
  return STRATEGY_REGISTRY.find((s) => s.id === id) ?? null;
}

