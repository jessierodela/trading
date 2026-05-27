import { clamp01 } from "../helpers";
import type { StrategyDefinition } from "../types";
import { GATE_EVALUATORS } from "./gates";
import type { GatedStrategyConfig } from "./types";

export function createGatedStrategy(config: GatedStrategyConfig): StrategyDefinition {
  return {
    id: config.id,
    version: config.version,
    name: config.name,

    evaluate(input) {
      const baseSignal = config.baseStrategy.evaluate(input);
      if (!baseSignal) return null;

      const { regime } = input;
      if (config.allowedRegimes && (!regime || !config.allowedRegimes.includes(regime.regime))) return null;
      if (regime && config.blockedRegimes?.includes(regime.regime)) return null;
      if (config.minRegimeReliability !== undefined && (!regime || regime.reliability < config.minRegimeReliability)) return null;

      const gateReasons: string[] = [];
      for (const gateId of config.gates ?? []) {
        const result = GATE_EVALUATORS[gateId]({ input, signal: baseSignal });
        if (!result.passed) return null;
        gateReasons.push(result.reason);
      }

      return {
        ...baseSignal,
        strategyId: config.id,
        strategyVersion: config.version,
        confidence: clamp01(baseSignal.confidence * (config.confidenceMultiplier ?? 1)),
        reasons: [
          ...baseSignal.reasons,
          `refined from ${config.baseStrategyId}`,
          ...gateReasons,
        ],
      };
    },
  };
}
