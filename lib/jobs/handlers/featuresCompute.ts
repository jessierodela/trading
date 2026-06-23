import { computeFeaturesLatest } from "@/lib/features/engine";
import type { JobPayload } from "@/lib/jobs/types";
import type { Exchange } from "@/lib/quant/types";
import { FEATURE_VERSION } from "@/lib/versions";
import {
  handlerSuccess,
  invalidPayload,
  requireService,
  retryableFailure,
  type JobHandler,
} from "./types";

const DEFAULT_RECENT_BAR_LIMIT = 300;

function isExchange(value: string): value is Exchange {
  return value === "COINBASE" || value === "BINANCE" || value === "POLYGON";
}

type FeaturesPayload = Extract<JobPayload, { jobType: "features.compute" }>;

export const handleFeaturesCompute: JobHandler<FeaturesPayload> = async (payload, context) => {
  if (!isExchange(payload.exchange)) {
    return invalidPayload("features.compute exchange is not supported", { exchange: payload.exchange });
  }
  if (payload.featureVersion !== FEATURE_VERSION) {
    return invalidPayload("features.compute requested unsupported featureVersion", {
      requested: payload.featureVersion,
      supported: FEATURE_VERSION,
    });
  }

  const barStore = requireService(context.services, "barStore", undefined);
  const featureStore = requireService(context.services, "featureStore", undefined);
  const symbols: Record<string, unknown> = {};
  let barsRead = 0;
  let featuresComputed = 0;
  let inserted = 0;

  try {
    for (const symbol of payload.symbols) {
      const bars = await barStore.fetchRecent(
        { symbol, exchange: payload.exchange, timeframe: payload.timeframe },
        DEFAULT_RECENT_BAR_LIMIT,
      );
      if (bars.length === 0) {
        return retryableFailure("source_bars_unavailable", {
          symbol,
          exchange: payload.exchange,
          timeframe: payload.timeframe,
        });
      }

      const computed = computeFeaturesLatest(bars);
      const insertedForSymbol = await featureStore.insertMany(computed.rows);
      barsRead += bars.length;
      featuresComputed += computed.rows.length;
      inserted += insertedForSymbol;
      symbols[symbol] = {
        barsRead: bars.length,
        featuresComputed: computed.rows.length,
        inserted: insertedForSymbol,
        seriesStartTs: computed.seriesStartTs,
        seriesEndTs: computed.seriesEndTs,
        droppedPreGapCount: computed.droppedPreGapCount,
      };
    }
  } catch (err) {
    return retryableFailure("features_compute_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return handlerSuccess({
    jobType: payload.jobType,
    exchange: payload.exchange,
    timeframe: payload.timeframe,
    featureVersion: payload.featureVersion,
    barsRead,
    featuresComputed,
    inserted,
    duplicatesSkipped: featuresComputed - inserted,
    symbols,
  });
};
