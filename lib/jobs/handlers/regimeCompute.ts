import { runRegimeDetector } from "@/lib/agents/regimeDetector";
import type { JobPayload } from "@/lib/jobs/types";
import {
  adaptFeatureSnapshotsToRegimeDetectorInput,
  runRegimeRefreshPipeline,
} from "@/lib/pipeline";
import type { Exchange, RegimeLabel } from "@/lib/quant/types";
import { mapRegimeToPermission } from "@/lib/regime/permissionMap";
import { REGIME_DETECTOR_PROMPT_VERSION, REGIME_MODEL_VERSION } from "@/lib/versions";
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

function refreshSymbolFor(symbol: string): string {
  return symbol.endsWith("-USD") ? symbol.slice(0, -4) : symbol;
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
  const runDetector = context.services.runRegimeDetector ?? runRegimeDetector;
  const runRefresh = context.services.runRegimeRefreshPipeline ?? runRegimeRefreshPipeline;
  const symbols: Record<string, unknown> = {};
  let persistedFeatureComputes = 0;
  let transitionalFallbackComputes = 0;

  try {
    for (const symbol of payload.symbols) {
      const feature1h = featureStore
        ? await featureStore.fetchLatest({
            symbol,
            exchange: payload.exchange,
            timeframe: "1h",
          })
        : null;

      if (feature1h) {
        const feature1d = featureStore
          ? await featureStore.fetchLatest({
              symbol,
              exchange: payload.exchange,
              timeframe: "1d",
            })
          : null;
        const { snapshot, snapshot1d } = adaptFeatureSnapshotsToRegimeDetectorInput({
          features1h: [feature1h],
          features1d: feature1d ? [feature1d] : [],
          now: context.now,
        });
        const signals = await runDetector(snapshot, snapshot1d, [symbol]);
        const signal = signals.find((s) => s.symbol === symbol);
        if (!signal) {
          return retryableFailure("regime_compute_no_output", { symbol, source: "persisted_features" });
        }
        const mapped = mapRegimeToPermission(signal.regime, signal.reliability);
        const row = await regimeStore.insert({
          symbol,
          exchange: payload.exchange,
          ts: feature1h.ts,
          regime: signal.regime as RegimeLabel,
          reliability: signal.reliability,
          directionalBias: mapped.directionalBias,
          tradePermission: mapped.tradePermission,
          edgeMultiplier: mapped.edgeMultiplier,
          sizeMultiplier: mapped.sizeMultiplier,
          reason: signal.reason,
          rawResponse: {
            source: "persisted_features",
            signal,
            featureTs: feature1h.ts,
            dailyFeatureTs: feature1d?.ts ?? null,
          },
          regimeModelVersion: payload.regimeModelVersion,
          promptVersion: REGIME_DETECTOR_PROMPT_VERSION,
          featureVersion: feature1h.featureVersion,
        });
        persistedFeatureComputes++;
        symbols[symbol] = {
          source: "persisted_features",
          regime: row.regime,
          reliability: row.reliability,
          ts: row.ts,
          id: row.id,
        };
        continue;
      }

      const refresh = await runRefresh({
        symbol: refreshSymbolFor(symbol),
        now: context.now,
      });
      if (!refresh.ok) {
        return retryableFailure("regime_refresh_fallback_failed", {
          symbol,
          status: refresh.status,
          body: refresh.body,
        });
      }
      const row = await regimeStore.insert({
        symbol,
        exchange: payload.exchange,
        ts: refresh.body.updatedAt,
        regime: refresh.body.regime as RegimeLabel,
        reliability: refresh.body.reliability,
        directionalBias: refresh.body.directionalBias as "UP" | "DOWN" | "NEUTRAL",
        tradePermission: refresh.body.tradePermission,
        edgeMultiplier: refresh.body.edgeMultiplier,
        sizeMultiplier: refresh.body.sizeMultiplier,
        reason: refresh.body.reason,
        rawResponse: {
          source: "taapi_transitional_fallback",
          refreshSymbol: refresh.body.symbol,
          body: refresh.body,
        },
        regimeModelVersion: REGIME_MODEL_VERSION,
        promptVersion: REGIME_DETECTOR_PROMPT_VERSION,
        featureVersion: null,
      });
      transitionalFallbackComputes++;
      symbols[symbol] = {
        source: "taapi_transitional_fallback",
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
    source: payload.source,
    persistedFeatureComputes,
    transitionalFallbackComputes,
    symbols,
  });
};
