import type { JobPayload } from "@/lib/jobs/types";
import type { Exchange } from "@/lib/quant/types";
import { getStrategyById } from "@/lib/strategies/strategyRegistry";
import { runStrategyWindow } from "@/lib/strategies/runStrategyWindow";
import {
  handlerSuccess,
  invalidPayload,
  requireService,
  retryableFailure,
  type JobHandler,
} from "./types";

const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DAILY_LOOKBACK_MS = 60 * 24 * 60 * 60 * 1000;

function isExchange(value: string): value is Exchange {
  return value === "COINBASE" || value === "BINANCE" || value === "POLYGON";
}

function isDuplicateInsert(err: unknown): boolean {
  return err instanceof Error && /duplicate|unique|strategy_signals_unique/i.test(err.message);
}

type StrategiesPayload = Extract<JobPayload, { jobType: "strategies.evaluate" }>;

export const handleStrategiesEvaluate: JobHandler<StrategiesPayload> = async (payload, context) => {
  if (!isExchange(payload.exchange)) {
    return invalidPayload("strategies.evaluate exchange is not supported", { exchange: payload.exchange });
  }
  const unknownStrategies = (payload.strategyIds ?? []).filter((id) => getStrategyById(id) === null);
  if (unknownStrategies.length > 0) {
    return invalidPayload("strategies.evaluate contains unknown strategyIds", { unknownStrategies });
  }

  const featureStore = requireService(context.services, "featureStore", undefined);
  const regimeStore = requireService(context.services, "regimeStore", undefined);
  const signalStore = requireService(context.services, "signalStore", undefined);
  const nowMs = context.now().getTime();
  const startTs = new Date(nowMs - LOOKBACK_MS).toISOString();
  const dailyStartTs = new Date(nowMs - DAILY_LOOKBACK_MS).toISOString();
  const endTs = context.now().toISOString();
  const allowed = payload.strategyIds ? new Set(payload.strategyIds) : null;

  let featuresRead = 0;
  let signalsEvaluated = 0;
  let inserted = 0;
  let duplicatesSkipped = 0;
  const byStrategy: Record<string, number> = {};
  const symbols: Record<string, unknown> = {};

  try {
    for (const symbol of payload.symbols) {
      const [features, dailyFeatures, regime] = await Promise.all([
        featureStore.fetchRange(
          { symbol, exchange: payload.exchange, timeframe: payload.timeframe },
          { startTs, endTs },
        ),
        featureStore.fetchRange(
          { symbol, exchange: payload.exchange, timeframe: "1d" },
          { startTs: dailyStartTs, endTs },
        ),
        regimeStore.latestAsContext({ symbol, exchange: payload.exchange }),
      ]);
      if (features.length === 0) {
        symbols[symbol] = { featuresRead: 0, signalsEvaluated: 0, inserted: 0, duplicatesSkipped: 0 };
        continue;
      }

      const result = await runStrategyWindow({
        features,
        dailyFeatures,
        regimeByTs: () => regime,
        persist: false,
      });
      const filteredSignals = allowed
        ? result.signals.filter((signal) => allowed.has(signal.strategyId))
        : result.signals;
      let insertedForSymbol = 0;
      let duplicatesForSymbol = 0;
      for (const signal of filteredSignals) {
        try {
          await signalStore.insert(signal);
          inserted++;
          insertedForSymbol++;
        } catch (err) {
          if (!isDuplicateInsert(err)) throw err;
          duplicatesSkipped++;
          duplicatesForSymbol++;
        }
        byStrategy[signal.strategyId] = (byStrategy[signal.strategyId] ?? 0) + 1;
      }
      featuresRead += result.featuresRead;
      signalsEvaluated += filteredSignals.length;
      symbols[symbol] = {
        featuresRead: result.featuresRead,
        signalsEvaluated: filteredSignals.length,
        inserted: insertedForSymbol,
        duplicatesSkipped: duplicatesForSymbol,
      };
    }
  } catch (err) {
    return retryableFailure("strategies_evaluate_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return handlerSuccess({
    jobType: payload.jobType,
    exchange: payload.exchange,
    timeframe: payload.timeframe,
    strategyIds: payload.strategyIds ?? "all",
    featuresRead,
    signalsEvaluated,
    inserted,
    duplicatesSkipped,
    byStrategy,
    symbols,
  });
};
