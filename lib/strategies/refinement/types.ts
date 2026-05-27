import type { RegimeLabel, StrategySignal } from "@/lib/quant/types";
import type { StrategyDefinition, StrategyInput } from "../types";

export type StrategyGateId =
  | "trend_confirmed"
  | "short_term_momentum_confirmed"
  | "price_above_medium_trend"
  | "macro_not_strongly_bearish"
  | "macro_trend_confirmed"
  | "volatility_expansion_confirmed"
  | "volatility_compression_confirmed"
  | "volume_confirmed"
  | "volume_not_dead"
  | "volume_not_weak"
  | "momentum_not_fading"
  | "oversold_confirmed"
  | "overbought_confirmed"
  | "avoid_overextended_entry"
  | "avoid_low_confidence_regime";

export interface GateResult {
  passed: boolean;
  reason: string;
}

export interface GateContext {
  input: StrategyInput;
  signal: StrategySignal;
}

export type GateEvaluator = (context: GateContext) => GateResult;

export interface GatedStrategyConfig {
  id: string;
  version: string;
  name: string;
  baseStrategy: StrategyDefinition;
  baseStrategyId: string;
  allowedRegimes?: readonly RegimeLabel[];
  blockedRegimes?: readonly RegimeLabel[];
  minRegimeReliability?: number;
  gates?: readonly StrategyGateId[];
  confidenceMultiplier?: number;
}

export interface RefinedStrategyPair {
  baseStrategyId: string;
  refinedStrategyId: string;
}
