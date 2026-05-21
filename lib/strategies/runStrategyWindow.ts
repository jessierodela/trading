import type {
  FeatureSnapshot,
  RegimeContext,
  StrategySignal,
} from "@/lib/quant/types";
import type { SignalStore } from "@/lib/storage";
import { runStrategies } from "./strategyRegistry";

export interface RunStrategyWindowOptions {
  features: FeatureSnapshot[];
  dailyFeatures?: FeatureSnapshot[];
  regimeByTs?: (ts: string) => RegimeContext | null;
  signalStore?: SignalStore;
  persist?: boolean;
}

export interface RunStrategyWindowResult {
  featuresRead: number;
  signals: StrategySignal[];
  inserted: number;
  duplicatesSkipped: number;
  byStrategy: Record<string, number>;
}

function assertWindowIntegrity(features: FeatureSnapshot[]): void {
  const seen = new Set<string>();
  let previousTs: string | null = null;
  let identity: Pick<FeatureSnapshot, "symbol" | "exchange" | "timeframe"> | null = null;

  for (const feature of features) {
    if (!identity) {
      identity = {
        symbol: feature.symbol,
        exchange: feature.exchange,
        timeframe: feature.timeframe,
      };
    } else if (
      feature.symbol !== identity.symbol ||
      feature.exchange !== identity.exchange ||
      feature.timeframe !== identity.timeframe
    ) {
      throw new Error("runStrategyWindow requires one symbol/exchange/timeframe per window");
    }

    if (seen.has(feature.ts)) {
      throw new Error(`runStrategyWindow duplicate timestamp: ${feature.ts}`);
    }
    seen.add(feature.ts);

    if (previousTs !== null && feature.ts <= previousTs) {
      throw new Error(`runStrategyWindow requires ascending features; ${feature.ts} came after ${previousTs}`);
    }
    previousTs = feature.ts;
  }
}

function latestDailyFor(
  current: FeatureSnapshot,
  dailyFeatures: FeatureSnapshot[] | undefined,
): FeatureSnapshot | null {
  if (!dailyFeatures || dailyFeatures.length === 0) return null;
  let daily: FeatureSnapshot | null = null;
  const sortedDaily = [...dailyFeatures].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const candidate of sortedDaily) {
    if (
      candidate.symbol !== current.symbol ||
      candidate.exchange !== current.exchange ||
      candidate.timeframe !== "1d"
    ) {
      continue;
    }
    if (candidate.ts <= current.ts) daily = candidate;
    if (candidate.ts > current.ts) break;
  }
  return daily;
}

function isDuplicateInsert(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return message.includes("duplicate") || message.includes("unique") || message.includes("strategy_signals_unique");
}

export async function runStrategyWindow(
  opts: RunStrategyWindowOptions,
): Promise<RunStrategyWindowResult> {
  assertWindowIntegrity(opts.features);

  const signals: StrategySignal[] = [];
  const byStrategy: Record<string, number> = {};

  for (let i = 0; i < opts.features.length; i++) {
    const current = opts.features[i];
    const emitted = runStrategies({
      current,
      previous: i > 0 ? opts.features[i - 1] : undefined,
      recent: opts.features.slice(Math.max(0, i - 50), i + 1),
      daily: latestDailyFor(current, opts.dailyFeatures),
      regime: opts.regimeByTs ? opts.regimeByTs(current.ts) : null,
    });

    for (const signal of emitted) {
      signals.push(signal);
      byStrategy[signal.strategyId] = (byStrategy[signal.strategyId] ?? 0) + 1;
    }
  }

  let inserted = 0;
  let duplicatesSkipped = 0;
  if (opts.persist === true && opts.signalStore) {
    for (const signal of signals) {
      try {
        await opts.signalStore.insert(signal);
        inserted++;
      } catch (err) {
        if (!isDuplicateInsert(err)) throw err;
        duplicatesSkipped++;
      }
    }
  }

  return {
    featuresRead: opts.features.length,
    signals,
    inserted,
    duplicatesSkipped,
    byStrategy,
  };
}
