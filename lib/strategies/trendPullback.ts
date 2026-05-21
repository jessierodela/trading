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

const STRATEGY_ID = "trend_pullback";
const STRATEGY_VERSION = STRATEGY_VERSIONS.trendPullback;

function hasBullishDailyContext(
  current: { daily_ema50AboveEma200?: boolean | null; daily_priceAboveEma200?: boolean | null },
  daily?: { ema50?: number | null; ema200?: number | null; close: number } | null,
): boolean {
  if (current.daily_ema50AboveEma200 === true || current.daily_priceAboveEma200 === true) return true;
  if (!daily) return true;
  if (isFiniteNumber(daily.ema50) && isFiniteNumber(daily.ema200) && daily.ema50 > daily.ema200) return true;
  if (isFiniteNumber(daily.ema200) && daily.close > daily.ema200) return true;
  return false;
}

export const trendPullback: StrategyDefinition = {
  id: STRATEGY_ID,
  version: STRATEGY_VERSION,
  name: "Trend Pullback",

  evaluate(input) {
    const { current, previous, daily, regime } = input;
    if (!hasFeatureVersion(current)) return null;
    if (isBlockedRegime(regime)) return null;
    if (!hasRequiredNumbers(current, ["close", "ema20", "rsi14", "macdHist", "atr14"])) return null;

    const reasons: string[] = [];
    let score = 0;

    if (hasBullishDailyContext(current, daily)) {
      score++;
      reasons.push("daily trend bullish or unavailable");
    }

    const nearEma20 = Math.abs(current.close - current.ema20!) / current.atr14! <= 0.75;
    if (nearEma20) {
      score++;
      reasons.push("price near ema20");
    }

    if (current.rsi14! >= 40 && current.rsi14! <= 50) {
      score++;
      reasons.push("rsi14 cooled into 40-50");
    }

    const macdPositive = current.macdHist! > 0;
    const macdImproving = previous && isFiniteNumber(previous.macdHist) && current.macdHist! > previous.macdHist;
    if (macdPositive) {
      score++;
      reasons.push("macdHist positive");
    }
    if (macdImproving) {
      score++;
      reasons.push("macdHist improving");
    }

    if (score < 3) return null;

    let signalType: "setup" | "trigger" = macdImproving && current.rsi14! >= 44 ? "trigger" : "setup";
    let confidence = confidenceFromScore(score, 5);

    if (isChop(regime)) {
      signalType = "setup";
      confidence *= 0.75;
      reasons.push("CHOP regime downgraded confidence");
    }

    const stopLoss = current.ema20! - current.atr14! * 1.25;
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
