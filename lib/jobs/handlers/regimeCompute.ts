import type { JobPayload } from "@/lib/jobs/types";
import {
  classifyFeatureRegime,
  toPersistableRegime,
} from "@/lib/regime/deterministicRegimeClassifier";
import type { Exchange } from "@/lib/quant/types";
import { mapRegimeToPermission } from "@/lib/regime/permissionMap";
import { DETERMINISTIC_REGIME_MODEL_VERSION } from "@/lib/versions";
import {
  handlerSuccess,
  invalidPayload,
  requireService,
  retryableFailure,
  type JobHandler,
} from "./types";

function isExchange(value: string): value is Exchange {
  return value === "COINBASE" || value === "BINANCE" || value === "POLYGON";
}

type RegimePayload = Extract<JobPayload, { jobType: "regime.compute" }>;

export const handleRegimeCompute: JobHandler<RegimePayload> = async (payload, context) => {
  if (!isExchange(payload.exchange)) {
    return invalidPayload("regime.compute exchange is not supported", { exchange: payload.exchange });
  }
  if (payload.timeframe !== "1h") {
    return invalidPayload("regime.compute currently supports timeframe=1h only", {
      timeframe: payload.timeframe,
    });
  }

  const regimeStore = requireService(context.services, "regimeStore", undefined);
  const featureStore = context.services.featureStore;
  const symbols: Record<string, unknown> = {};
  let deterministicComputes = 0;
  let persistedFeatureComputes = 0;
  let unknownComputes = 0;

  try {
    for (const symbol of payload.symbols) {
      const feature1h = featureStore
        ? await featureStore.fetchLatest({
            symbol,
            exchange: payload.exchange,
            timeframe: "1h",
          })
        : null;

      const feature1d = featureStore
        ? await featureStore.fetchLatest({
            symbol,
            exchange: payload.exchange,
            timeframe: "1d",
          })
        : null;

      const classifier = classifyFeatureRegime(feature1h, feature1d, {
        symbol,
        timestamp: feature1h?.ts ?? context.now().toISOString(),
        source: feature1h ? "persisted_feature_snapshots" : "missing_feature_snapshot_safe_fallback",
      });
      const persisted = toPersistableRegime(classifier);
      const mapped = mapRegimeToPermission(persisted.regime, persisted.reliability);
      const row = await regimeStore.insert({
        symbol,
        exchange: payload.exchange,
        ts: feature1h?.ts ?? classifier.timestamp,
        regime: persisted.regime,
        reliability: persisted.reliability,
        directionalBias: mapped.directionalBias,
        tradePermission: mapped.tradePermission,
        edgeMultiplier: mapped.edgeMultiplier,
        sizeMultiplier: mapped.sizeMultiplier,
        reason: persisted.reason,
        rawResponse: {
          source: "deterministic_regime_classifier",
          classifier,
          persisted,
          featureTs: feature1h?.ts ?? null,
          dailyFeatureTs: feature1d?.ts ?? null,
          requestedRegimeModelVersion: payload.regimeModelVersion,
          aiUsed: false,
        },
        regimeModelVersion: DETERMINISTIC_REGIME_MODEL_VERSION,
        promptVersion: null,
        featureVersion: feature1h?.featureVersion ?? null,
      });
      deterministicComputes++;
      if (feature1h) persistedFeatureComputes++;
      if (classifier.regime === "UNKNOWN") unknownComputes++;
      symbols[symbol] = {
        source: "deterministic_regime_classifier",
        classifierRegime: classifier.regime,
        persistedRegime: persisted.regime,
        regime: row.regime,
        reliability: row.reliability,
        ts: row.ts,
        id: row.id,
      };
    }
  } catch (err) {
    return retryableFailure("regime_compute_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return handlerSuccess({
    jobType: payload.jobType,
    exchange: payload.exchange,
    timeframe: payload.timeframe,
    requestedRegimeModelVersion: payload.regimeModelVersion,
    regimeModelVersion: DETERMINISTIC_REGIME_MODEL_VERSION,
    source: payload.source,
    aiUsed: false,
    deterministicComputes,
    persistedFeatureComputes,
    unknownComputes,
    symbols,
  });
};
