import { STRATEGY_VERSIONS } from "@/lib/versions";
import { breakoutExpansion } from "../breakoutExpansion";
import { meanReversionBounce } from "../meanReversionBounce";
import { momentumContinuation } from "../momentumContinuation";
import { trendPullback } from "../trendPullback";
import { createGatedStrategy } from "./createGatedStrategy";
import type { RefinedStrategyPair } from "./types";

export const momentumContinuationRefinedV1 = createGatedStrategy({
  id: "momentum_continuation_refined_v1",
  version: STRATEGY_VERSIONS.momentumContinuationRefinedV1,
  name: "Momentum Continuation Refined v1",
  baseStrategy: momentumContinuation,
  baseStrategyId: momentumContinuation.id,
  allowedRegimes: ["TREND_UP", "LOW_VOL", "TREND_DOWN"],
  blockedRegimes: ["CHOP", "NEWS_SHOCK"],
  minRegimeReliability: 0.65,
  gates: [
    "short_term_momentum_confirmed",
    "price_above_medium_trend",
    "macro_not_strongly_bearish",
    "volume_not_dead",
    "momentum_not_fading",
    "avoid_overextended_entry",
    "avoid_low_confidence_regime",
  ],
});

export const breakoutExpansionRefinedV1 = createGatedStrategy({
  id: "breakout_expansion_refined_v1",
  version: STRATEGY_VERSIONS.breakoutExpansionRefinedV1,
  name: "Breakout Expansion Refined v1",
  baseStrategy: breakoutExpansion,
  baseStrategyId: breakoutExpansion.id,
  allowedRegimes: ["TREND_UP", "HIGH_VOL"],
  blockedRegimes: ["LOW_VOL", "TREND_DOWN", "CHOP", "NEWS_SHOCK"],
  minRegimeReliability: 0.65,
  gates: [
    "volatility_expansion_confirmed",
    "volume_confirmed",
    "price_near_or_above_breakout_structure",
    "trend_confirmed",
    "macro_trend_confirmed",
    "avoid_overextended_entry",
    "avoid_low_confidence_regime",
  ],
});

export const trendPullbackRefinedV1 = createGatedStrategy({
  id: "trend_pullback_refined_v1",
  version: STRATEGY_VERSIONS.trendPullbackRefinedV1,
  name: "Trend Pullback Refined v1",
  baseStrategy: trendPullback,
  baseStrategyId: trendPullback.id,
  allowedRegimes: ["TREND_UP", "HIGH_VOL"],
  blockedRegimes: ["TREND_DOWN", "CHOP", "LOW_VOL", "NEWS_SHOCK"],
  minRegimeReliability: 0.65,
  gates: [
    "strong_macro_trend_confirmed",
    "pullback_into_support_zone",
    "trend_not_broken",
    "momentum_reset_without_reversal",
    "volume_not_weak",
    "avoid_overextended_entry",
    "avoid_low_confidence_regime",
  ],
});

export const meanReversionRefinedV1 = createGatedStrategy({
  id: "mean_reversion_refined_v1",
  version: STRATEGY_VERSIONS.meanReversionRefinedV1,
  name: "Mean Reversion Refined v1",
  baseStrategy: meanReversionBounce,
  baseStrategyId: meanReversionBounce.id,
  allowedRegimes: ["LOW_VOL", "CHOP"],
  blockedRegimes: ["TREND_DOWN", "TREND_UP", "HIGH_VOL", "NEWS_SHOCK"],
  minRegimeReliability: 0.65,
  gates: [
    "oversold_confirmed",
    "range_bound_context",
    "volatility_not_expanding_aggressively_against_trade",
    "price_stretched_from_mean",
    "reversion_target_available",
    "avoid_low_confidence_regime",
  ],
});

export const REFINED_STRATEGY_VARIANTS = [
  momentumContinuationRefinedV1,
  trendPullbackRefinedV1,
  breakoutExpansionRefinedV1,
  meanReversionRefinedV1,
] as const;

export const REFINED_STRATEGY_PAIRS: readonly RefinedStrategyPair[] = [
  { baseStrategyId: momentumContinuation.id, refinedStrategyId: momentumContinuationRefinedV1.id },
  { baseStrategyId: breakoutExpansion.id, refinedStrategyId: breakoutExpansionRefinedV1.id },
  { baseStrategyId: trendPullback.id, refinedStrategyId: trendPullbackRefinedV1.id },
  { baseStrategyId: meanReversionBounce.id, refinedStrategyId: meanReversionRefinedV1.id },
];
