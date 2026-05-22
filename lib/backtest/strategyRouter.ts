import type { RegimeLabel, StrategySignal } from "@/lib/quant/types";
import { getStrategyById } from "@/lib/strategies/strategyRegistry";
import type { StrategyInput } from "@/lib/strategies/types";
import type { StrategyRouter } from "./types";

export type RegimeStrategyMap = Partial<Record<RegimeLabel, readonly string[]>>;

export interface RegimeStrategyRouterConfig {
  id: string;
  version: string;
  regimeStrategyMap: RegimeStrategyMap;
}

export const DEFAULT_A6_REGIME_STRATEGY_MAP: RegimeStrategyMap = {
  TREND_UP: ["breakout_expansion", "momentum_continuation"],
  TREND_DOWN: ["momentum_continuation"],
  HIGH_VOL: ["mean_reversion_bounce", "trend_pullback"],
  LOW_VOL: ["mean_reversion_bounce"],
  NEWS_SHOCK: ["momentum_continuation"],
  CHOP: ["momentum_continuation", "mean_reversion_bounce"],
};

export const DEFAULT_A6_REGIME_ROUTER_CONFIG: RegimeStrategyRouterConfig = {
  id: "a6_regime_router",
  version: "a6-regime-router.research.v1",
  regimeStrategyMap: DEFAULT_A6_REGIME_STRATEGY_MAP,
};

export function createRegimeStrategyRouter(config: RegimeStrategyRouterConfig): StrategyRouter {
  return {
    id: config.id,
    version: config.version,
    evaluate(input: StrategyInput): StrategySignal | null {
      const regime = input.regime?.regime;
      if (!regime) return null;

      const strategyIds = config.regimeStrategyMap[regime] ?? [];
      if (strategyIds.length === 0) return null;

      const signals = strategyIds
        .map((strategyId) => {
          const strategy = getStrategyById(strategyId);
          if (!strategy) throw new Error(`unknown routed strategyId: ${strategyId}`);
          return strategy.evaluate(input);
        })
        .filter((signal): signal is StrategySignal =>
          signal !== null &&
          signal.signalType === "trigger" &&
          signal.direction !== "none",
        );

      if (signals.length === 0) return null;
      return signals.sort((a, b) => b.confidence - a.confidence)[0];
    },
  };
}

export const defaultA6RegimeRouter = createRegimeStrategyRouter(DEFAULT_A6_REGIME_ROUTER_CONFIG);
