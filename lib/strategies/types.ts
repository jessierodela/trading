import type {
  FeatureSnapshot,
  RegimeContext,
  StrategySignal,
} from "@/lib/quant/types";

export interface StrategyInput {
  current: FeatureSnapshot;
  previous?: FeatureSnapshot;
  recent: FeatureSnapshot[];
  daily?: FeatureSnapshot | null;
  regime?: RegimeContext | null;
}

export interface StrategyDefinition {
  id: string;
  version: string;
  name: string;
  evaluate(input: StrategyInput): StrategySignal | null;
}

