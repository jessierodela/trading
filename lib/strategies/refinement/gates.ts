import type { FeatureSnapshot } from "@/lib/quant/types";
import { clamp01, isFiniteNumber } from "../helpers";
import type { GateContext, GateEvaluator, StrategyGateId } from "./types";

function pass(reason: string) {
  return { passed: true, reason };
}

function fail(reason: string) {
  return { passed: false, reason };
}

function previousFeature(context: GateContext): FeatureSnapshot | undefined {
  return context.input.previous;
}

export const GATE_EVALUATORS: Record<StrategyGateId, GateEvaluator> = {
  trend_confirmed(context) {
    const { current } = context.input;
    if (
      isFiniteNumber(current.close) &&
      isFiniteNumber(current.ema20) &&
      isFiniteNumber(current.ema50) &&
      current.close > current.ema20 &&
      current.ema20 >= current.ema50
    ) {
      return pass("gate trend_confirmed");
    }
    if (
      isFiniteNumber(current.close) &&
      isFiniteNumber(current.ema20) &&
      isFiniteNumber(current.ema20Slope) &&
      current.close > current.ema20 &&
      current.ema20Slope > 0
    ) {
      return pass("gate trend_confirmed via ema20 slope");
    }
    return fail("gate trend_confirmed failed");
  },

  short_term_momentum_confirmed(context) {
    const { current } = context.input;
    const previous = previousFeature(context);
    if (
      previous &&
      isFiniteNumber(current.macdHist) &&
      isFiniteNumber(previous.macdHist) &&
      current.macdHist > 0 &&
      current.macdHist > previous.macdHist
    ) {
      return pass("gate short_term_momentum_confirmed via macdHist");
    }
    if (
      isFiniteNumber(current.ema20Slope) &&
      current.ema20Slope > 0 &&
      isFiniteNumber(current.rsi14) &&
      current.rsi14 >= 50 &&
      current.rsi14 <= 68
    ) {
      return pass("gate short_term_momentum_confirmed via ema20/rsi");
    }
    return fail("gate short_term_momentum_confirmed failed");
  },

  price_above_medium_trend(context) {
    const { current } = context.input;
    if (isFiniteNumber(current.close) && isFiniteNumber(current.ema50) && current.close > current.ema50) {
      return pass("gate price_above_medium_trend");
    }
    if (
      isFiniteNumber(current.close) &&
      isFiniteNumber(current.ema20) &&
      isFiniteNumber(current.ema20Slope) &&
      current.close > current.ema20 &&
      current.ema20Slope > 0
    ) {
      return pass("gate price_above_medium_trend via ema20 slope");
    }
    return fail("gate price_above_medium_trend failed");
  },

  macro_not_strongly_bearish(context) {
    const { current, daily } = context.input;
    if (current.daily_ema50AboveEma200 === true || current.daily_priceAboveEma200 === true) {
      return pass("gate macro_not_strongly_bearish");
    }
    if (current.daily_ema50AboveEma200 === false && current.daily_priceAboveEma200 === false) {
      return fail("gate macro_not_strongly_bearish failed: daily flags bearish");
    }
    if (!daily) return pass("gate macro_not_strongly_bearish unavailable");
    const emaBearish = isFiniteNumber(daily.ema50) && isFiniteNumber(daily.ema200) && daily.ema50 < daily.ema200;
    const priceBearish = isFiniteNumber(daily.ema200) && daily.close < daily.ema200;
    return emaBearish && priceBearish
      ? fail("gate macro_not_strongly_bearish failed")
      : pass("gate macro_not_strongly_bearish");
  },

  macro_trend_confirmed(context) {
    const { current, daily } = context.input;
    if (current.daily_ema50AboveEma200 === true || current.daily_priceAboveEma200 === true) {
      return pass("gate macro_trend_confirmed");
    }
    if (!daily) return pass("gate macro_trend_confirmed unavailable");
    if (isFiniteNumber(daily.ema50) && isFiniteNumber(daily.ema200) && daily.ema50 > daily.ema200) {
      return pass("gate macro_trend_confirmed via daily ema50>ema200");
    }
    if (isFiniteNumber(daily.ema200) && daily.close > daily.ema200) {
      return pass("gate macro_trend_confirmed via daily close>ema200");
    }
    return fail("gate macro_trend_confirmed failed");
  },

  volatility_expansion_confirmed(context) {
    const { current } = context.input;
    if (isFiniteNumber(current.bbWidth) && isFiniteNumber(current.bbWidthPrev)) {
      const previousWidth = Math.abs(current.bbWidthPrev);
      const widthExpansionPct = previousWidth === 0
        ? (current.bbWidth > 0 ? 1 : 0)
        : (current.bbWidth - current.bbWidthPrev) / previousWidth;
      if (widthExpansionPct >= 0.015) {
        return pass("gate volatility_expansion_confirmed");
      }
      if (
        current.bbWidth > current.bbWidthPrev &&
        isFiniteNumber(current.candleRangeAtr) &&
        current.candleRangeAtr >= 0.9 &&
        current.candleRangeAtr <= 2.25
      ) {
        return pass("gate volatility_expansion_confirmed via width/range");
      }
    }
    if (isFiniteNumber(current.candleRangeAtr) && current.candleRangeAtr >= 1 && current.candleRangeAtr <= 2.25) {
      return pass("gate volatility_expansion_confirmed via range");
    }
    return fail("gate volatility_expansion_confirmed failed");
  },

  price_near_or_above_breakout_structure(context) {
    const { current } = context.input;
    if (
      isFiniteNumber(current.close) &&
      isFiniteNumber(current.bbUpper) &&
      current.close >= current.bbUpper
    ) {
      return pass("gate price_near_or_above_breakout_structure");
    }
    if (
      isFiniteNumber(current.close) &&
      isFiniteNumber(current.bbUpper) &&
      isFiniteNumber(current.atr14) &&
      current.close >= current.bbUpper - current.atr14 * 0.15
    ) {
      return pass("gate price_near_or_above_breakout_structure via near upper band");
    }
    if (
      isFiniteNumber(current.close) &&
      isFiniteNumber(current.ema20) &&
      isFiniteNumber(current.ema50) &&
      current.close > current.ema20 &&
      current.ema20 > current.ema50
    ) {
      return pass("gate price_near_or_above_breakout_structure via trend stack");
    }
    return fail("gate price_near_or_above_breakout_structure failed");
  },

  volatility_compression_confirmed(context) {
    const { current } = context.input;
    if (isFiniteNumber(current.bbWidth) && isFiniteNumber(current.bbWidthPrev) && current.bbWidth <= current.bbWidthPrev) {
      return pass("gate volatility_compression_confirmed");
    }
    if (isFiniteNumber(current.atrPct) && current.atrPct <= 3.5) {
      return pass("gate volatility_compression_confirmed via atrPct");
    }
    return fail("gate volatility_compression_confirmed failed");
  },

  volume_confirmed(context) {
    const { current } = context.input;
    if (!isFiniteNumber(current.relativeVolume20)) return pass("gate volume_confirmed unavailable");
    return current.relativeVolume20 >= 1.1
      ? pass("gate volume_confirmed")
      : fail("gate volume_confirmed failed");
  },

  volume_not_dead(context) {
    const { current } = context.input;
    if (!isFiniteNumber(current.relativeVolume20)) return pass("gate volume_not_dead unavailable");
    return current.relativeVolume20 >= 0.6
      ? pass("gate volume_not_dead")
      : fail("gate volume_not_dead failed");
  },

  volume_not_weak(context) {
    const { current } = context.input;
    if (!isFiniteNumber(current.relativeVolume20)) return pass("gate volume_not_weak unavailable");
    return current.relativeVolume20 >= 0.8
      ? pass("gate volume_not_weak")
      : fail("gate volume_not_weak failed");
  },

  momentum_not_fading(context) {
    const { current } = context.input;
    const previous = previousFeature(context);
    if (
      previous &&
      isFiniteNumber(current.macdHist) &&
      isFiniteNumber(previous.macdHist) &&
      current.macdHist < previous.macdHist &&
      current.macdHist <= 0
    ) {
      return fail("gate momentum_not_fading failed: macdHist fading below zero");
    }
    if (isFiniteNumber(current.ema20Slope) && current.ema20Slope < 0) {
      return fail("gate momentum_not_fading failed: ema20 slope negative");
    }
    return pass("gate momentum_not_fading");
  },

  oversold_confirmed(context) {
    const { current } = context.input;
    const previous = previousFeature(context);
    if (isFiniteNumber(current.rsi14) && current.rsi14 <= 35) return pass("gate oversold_confirmed");
    if (
      previous &&
      isFiniteNumber(previous.rsi14) &&
      isFiniteNumber(current.rsi14) &&
      previous.rsi14 < 40 &&
      current.rsi14 > previous.rsi14
    ) {
      return pass("gate oversold_confirmed via rsi turn");
    }
    return fail("gate oversold_confirmed failed");
  },

  overbought_confirmed(context) {
    const { current } = context.input;
    if (isFiniteNumber(current.rsi14) && current.rsi14 >= 65) return pass("gate overbought_confirmed");
    return fail("gate overbought_confirmed failed");
  },

  avoid_overextended_entry(context) {
    const { current } = context.input;
    if (isFiniteNumber(current.candleRangeAtr) && current.candleRangeAtr > 2.25) {
      return fail("gate avoid_overextended_entry failed: candle range extended");
    }
    if (isFiniteNumber(current.distanceFromEma20Atr) && current.distanceFromEma20Atr > 2.25) {
      return fail("gate avoid_overextended_entry failed: distance from ema20 extended");
    }
    if (isFiniteNumber(current.rsi14) && current.rsi14 > 75) {
      return fail("gate avoid_overextended_entry failed: rsi overextended");
    }
    return pass("gate avoid_overextended_entry");
  },

  avoid_low_confidence_regime(context) {
    const { regime } = context.input;
    if (!regime) return pass("gate avoid_low_confidence_regime unavailable");
    return clamp01(regime.reliability) >= 0.55
      ? pass("gate avoid_low_confidence_regime")
      : fail("gate avoid_low_confidence_regime failed");
  },
};
