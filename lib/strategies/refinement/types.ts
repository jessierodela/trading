import type { RegimeLabel, StrategySignal } from "@/lib/quant/types";
import type { StrategyDefinition, StrategyInput } from "../types";

export type StrategyGateId =
  | "trend_confirmed"
  | "short_term_momentum_confirmed"
  | "price_above_medium_trend"
  | "macro_not_strongly_bearish"
  | "macro_trend_confirmed"
  | "strong_macro_trend_confirmed"
  | "volatility_expansion_confirmed"
  | "volatility_compression_confirmed"
  | "price_near_or_above_breakout_structure"
  | "pullback_into_support_zone"
  | "trend_not_broken"
  | "momentum_reset_without_reversal"
  | "range_bound_context"
  | "volatility_not_expanding_aggressively_against_trade"
  | "price_stretched_from_mean"
  | "reversion_target_available"
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
