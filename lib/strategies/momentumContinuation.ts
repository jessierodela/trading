import { STRATEGY_VERSIONS } from "@/lib/versions";
import type { StrategyDefinition } from "./types";
import {
  confidenceFromScore,
  hasFeatureVersion,
  hasRequiredNumbers,
  isBlockedRegime,
  isChop,
  isFiniteNumber,
  isTrendDownReliable,
  isTrendUp,
  makeSignal,
} from "./helpers";

const STRATEGY_ID = "momentum_continuation";
const STRATEGY_VERSION = STRATEGY_VERSIONS.momentumContinuation;

export const momentumContinuation: StrategyDefinition = {
  id: STRATEGY_ID,
  version: STRATEGY_VERSION,
  name: "Momentum Continuation",

  evaluate(input) {
    const { current, previous, regime } = input;
    if (!hasFeatureVersion(current)) return null;
    if (isBlockedRegime(regime)) return null;
    if (!hasRequiredNumbers(current, ["close", "ema20", "ema20Slope", "macdHist", "rsi14", "atr14"])) {
      return null;
    }
    if (!previous || !isFiniteNumber(previous.macdHist)) return null;

    const reasons: string[] = [];
    let score = 0;

    if (current.close > current.ema20!) {
      score++;
      reasons.push("close above ema20");
    }
    if (current.ema20Slope! > 0) {
      score++;
      reasons.push("ema20 slope positive");
    }
    if (current.macdHist! > 0) {
      score++;
      reasons.push("macdHist positive");
    }
    if (current.macdHist! > previous.macdHist) {
      score++;
      reasons.push("macdHist expanding");
    }
    if (current.rsi14! >= 50 && current.rsi14! <= 70) {
      score++;
      reasons.push("rsi14 in continuation band");
    }

    const rangeOk = !isFiniteNumber(current.candleRangeAtr) || current.candleRangeAtr <= 2.25;
    if (rangeOk) {
      score++;
      reasons.push("candle range not extended");
    }

    if (isTrendUp(regime)) {
      score++;
      reasons.push("regime TREND_UP");
    } else if (!regime) {
      score += 0.5;
      reasons.push("regime neutral");
    }

    if (score < 4.5) return null;

    let signalType: "setup" | "trigger" = score >= 6 ? "trigger" : "setup";
    let confidence = confidenceFromScore(score, 7);

    if (isChop(regime)) {
      signalType = "setup";
      confidence *= 0.75;
      reasons.push("CHOP regime downgraded confidence");
    }
    if (isTrendDownReliable(regime)) {
      signalType = "setup";
      confidence *= 0.6;
      reasons.push("reliable TREND_DOWN downgraded long continuation");
    }

    const stopLoss = current.ema20! - current.atr14! * 1.5;
    return makeSignal({
      current,
      strategyId: STRATEGY_ID,
      strategyVersion: STRATEGY_VERSION,
      signalType,
      direction: "long",
      confidence,
      reasons,
      stopLoss,
      invalidationPrice: stopLoss,
    });
  },
};
