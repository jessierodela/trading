import { STRATEGY_VERSIONS } from "@/lib/versions";
import type { StrategyDefinition } from "./types";
import {
  clamp01,
  confidenceFromScore,
  hasFeatureVersion,
  hasRequiredNumbers,
  isBlockedRegime,
  isFiniteNumber,
  isTrendDownReliable,
  makeSignal,
} from "./helpers";

const STRATEGY_ID = "mean_reversion_bounce";
const STRATEGY_VERSION = STRATEGY_VERSIONS.meanReversionBounce;

export const meanReversionBounce: StrategyDefinition = {
  id: STRATEGY_ID,
  version: STRATEGY_VERSION,
  name: "Mean Reversion Bounce",

  evaluate(input) {
    const { current, previous, regime } = input;
    if (!hasFeatureVersion(current)) return null;
    if (isBlockedRegime(regime)) return null;
    if (!hasRequiredNumbers(current, ["rsi14", "distanceFromEma20Atr", "macdHist", "atr14", "close", "ema20"])) {
      return null;
    }

    const reasons: string[] = [];
    let score = 0;

    const rsiOversold = current.rsi14! < 30;
    const rsiRisingFromOversold = previous &&
      isFiniteNumber(previous.rsi14) &&
      previous.rsi14 < 35 &&
      current.rsi14! > previous.rsi14;
    if (rsiOversold || rsiRisingFromOversold) {
      score++;
      reasons.push(rsiOversold ? "rsi14 oversold" : "rsi14 rising from sub-35");
    }

    if (current.distanceFromEma20Atr! <= -1.2) {
      score++;
      reasons.push("price stretched below ema20");
    }

    if (previous && isFiniteNumber(previous.macdHist) && current.macdHist! > previous.macdHist) {
      score++;
      reasons.push("macdHist improving");
    }

    if (current.close < current.ema20!) {
      score++;
      reasons.push("price remains below ema20 mean");
    }

    if (score < 2) return null;

    let signalType: "setup" | "trigger" = score >= 3 && current.macdHist! > (previous?.macdHist ?? current.macdHist! - 1)
      ? "trigger"
      : "setup";
    let confidence = Math.min(0.65, confidenceFromScore(score, 4) * 0.85);

    if (isTrendDownReliable(regime)) {
      signalType = "setup";
      confidence = clamp01(confidence * 0.75);
      reasons.push("reliable TREND_DOWN caps countertrend bounce");
    }

    const stopLoss = current.close - current.atr14! * 1.25;
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
