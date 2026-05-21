import { STRATEGY_VERSIONS } from "@/lib/versions";
import type { StrategyDefinition } from "./types";
import {
  confidenceFromScore,
  hasFeatureVersion,
  hasRequiredNumbers,
  isBlockedRegime,
  isChop,
  isFiniteNumber,
  makeSignal,
} from "./helpers";

export const breakoutExpansion: StrategyDefinition = {
  id: "breakout_expansion",
  version: STRATEGY_VERSIONS.breakoutExpansion,
  name: "Breakout Expansion",

  evaluate(input) {
    const { current, regime } = input;
    if (!hasFeatureVersion(current)) return null;
    if (isBlockedRegime(regime)) return null;
    if (!hasRequiredNumbers(current, ["close", "bbUpper", "bbWidth", "bbWidthPrev", "atr14"])) return null;

    const reasons: string[] = [];
    let score = 0;

    if (current.bbWidth! > current.bbWidthPrev!) {
      score++;
      reasons.push("bbWidth expanding");
    }
    if (current.close > current.bbUpper!) {
      score++;
      reasons.push("close above upper band");
    }

    if (!isFiniteNumber(current.relativeVolume20) || current.relativeVolume20 > 1.2) {
      score++;
      reasons.push(isFiniteNumber(current.relativeVolume20) ? "relative volume confirmed" : "volume confirmation unavailable");
    }

    if (!isFiniteNumber(current.macdHist) || current.macdHist > 0) {
      score++;
      reasons.push(isFiniteNumber(current.macdHist) ? "macdHist positive" : "macd confirmation unavailable");
    }

    const rangeOk = !isFiniteNumber(current.candleRangeAtr) || current.candleRangeAtr <= 2.75;
    const atrPctOk = !isFiniteNumber(current.atrPct) || current.atrPct <= 8;
    if (rangeOk && atrPctOk) {
      score++;
      reasons.push("range expansion not excessive");
    }

    if (score < 4) return null;

    let signalType: "setup" | "trigger" = "trigger";
    let confidence = confidenceFromScore(score, 5);

    if (isChop(regime)) {
      signalType = score >= 5 ? "trigger" : "setup";
      confidence *= signalType === "trigger" ? 0.85 : 0.7;
      reasons.push("CHOP regime requires stronger breakout confirmation");
    }

    const stopLoss = isFiniteNumber(current.bbMiddle)
      ? current.bbMiddle
      : current.close - current.atr14! * 1.5;

    return makeSignal({
      current,
      strategyId: this.id,
      strategyVersion: this.version,
      signalType,
      direction: "long",
      confidence,
      reasons,
      stopLoss,
      invalidationPrice: stopLoss,
    });
  },
};

