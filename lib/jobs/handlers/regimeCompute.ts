import type { JobPayload } from "@/lib/jobs/types";
import {
  combineDataQualityReports,
  type DataQualityReport,
} from "@/lib/dataQuality/types";
import {
  missingFeatureReport,
  validateFeatureSnapshotQuality,
} from "@/lib/dataQuality/featureQuality";
import { normalizeMarketIdentity } from "@/lib/dataQuality/marketIdentity";
import { jobDataQualitySummary } from "@/lib/dataQuality/qualityGate";
import {
  buildDerivedSourceLineage,
  sourceLineageFromFeature,
  sourceLineageQualityReport,
} from "@/lib/market/sourceLineage";
import {
  classifyFeatureRegime,
  toPersistableRegime,
  type PersistableRegimeResult,
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

function capReliability(
  persisted: PersistableRegimeResult,
  cap: number,
  reason: string,
): PersistableRegimeResult {
  if (persisted.reliability <= cap) {
    return {
      ...persisted,
      reason: `${persisted.reason}; ${reason}`,
    };
  }
  return {
    ...persisted,
    reliability: cap,
    reason: `${persisted.reason}; ${reason}; reliability_capped=${cap.toFixed(2)}`,
  };
}

function shouldDropDailyContext(report: DataQualityReport): boolean {
  return report.issues.some((issue) =>
    issue.severity === "block" ||
    issue.code === "FEATURE_MISSING" ||
    issue.code === "FEATURE_STALE" ||
    issue.code === "FEATURE_TIMESTAMP_INCOMPLETE"
  );
}

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
  const dataQualityReports: DataQualityReport[] = [];

  try {
    for (const symbol of payload.symbols) {
      const now = context.now();
      const expectedIdentity = normalizeMarketIdentity({
        symbol,
        exchange: payload.exchange,
        source: "coinbase",
      });
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

      const feature1hQuality = feature1h
        ? validateFeatureSnapshotQuality({
            feature: feature1h,
            expectedIdentity,
            timeframe: "1h",
            now,
          })
        : missingFeatureReport({
            symbol,
            exchange: payload.exchange,
            timeframe: "1h",
            now,
            severity: "block",
          });
      const feature1dQuality = feature1d
        ? validateFeatureSnapshotQuality({
            feature: feature1d,
            expectedIdentity,
            timeframe: "1d",
            now,
            staleSeverity: "warn",
          })
        : missingFeatureReport({
            symbol,
            exchange: payload.exchange,
            timeframe: "1d",
            now,
            severity: "warn",
          });
      const lineageReport = sourceLineageQualityReport({
        scope: "regime.compute.source_lineage",
        checkedAt: now.toISOString(),
        expectedIdentity,
        lineages: [feature1h?.sourceLineage, feature1d?.sourceLineage],
        symbol,
        exchange: payload.exchange,
        timeframe: "1h",
      });
      const symbolDataQuality = combineDataQualityReports({
        scope: "regime.compute.symbol",
        checkedAt: now.toISOString(),
        reports: [feature1hQuality, feature1dQuality, lineageReport],
        symbol,
        exchange: payload.exchange,
        timeframe: "1h",
      });
      dataQualityReports.push(symbolDataQuality);

      const block1h = !feature1hQuality.ok || !lineageReport.ok;
      const reducedDailyContext = shouldDropDailyContext(feature1dQuality);
      const classifier = classifyFeatureRegime(
        block1h ? null : feature1h,
        reducedDailyContext ? null : feature1d,
        {
        symbol,
        timestamp: block1h ? now.toISOString() : feature1h?.ts ?? now.toISOString(),
        source: block1h
          ? "data_quality_safe_fallback"
          : reducedDailyContext
            ? "persisted_feature_snapshots_reduced_daily_context"
            : "persisted_feature_snapshots",
        },
      );
      let persisted = toPersistableRegime(classifier);
      if (block1h) {
        persisted = capReliability(persisted, 0.25, "data_quality_blocked_1h_feature");
      } else if (reducedDailyContext) {
        persisted = capReliability(persisted, 0.55, "reduced_daily_context");
      }
      const mapped = mapRegimeToPermission(persisted.regime, persisted.reliability);
      const regimeSourceLineage = buildDerivedSourceLineage({
        kind: "regime_snapshot",
        source: "regime.compute",
        transform: DETERMINISTIC_REGIME_MODEL_VERSION,
        transformedAt: block1h ? now.toISOString() : feature1h?.ts ?? classifier.timestamp,
        identity: expectedIdentity,
        inputSources: [feature1h, reducedDailyContext ? null : feature1d]
          .filter((feature): feature is NonNullable<typeof feature1h> => feature !== null && feature !== undefined)
          .map(sourceLineageFromFeature),
        featureVersion: feature1h?.featureVersion ?? null,
        modelVersion: DETERMINISTIC_REGIME_MODEL_VERSION,
        notes: [
          block1h ? "data_quality_blocked_1h_feature" : "1h_feature_trusted",
          reducedDailyContext ? "reduced_daily_context" : "daily_context_included",
        ],
      });
      const row = await regimeStore.insert({
        symbol,
        exchange: payload.exchange,
        ts: block1h ? now.toISOString() : feature1h?.ts ?? classifier.timestamp,
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
          dataQuality: symbolDataQuality,
          sourceLineage: regimeSourceLineage,
          requestedRegimeModelVersion: payload.regimeModelVersion,
          aiUsed: false,
        },
        regimeModelVersion: DETERMINISTIC_REGIME_MODEL_VERSION,
        promptVersion: null,
        featureVersion: feature1h?.featureVersion ?? null,
        sourceLineage: regimeSourceLineage,
      });
      deterministicComputes++;
      if (feature1h && !block1h) persistedFeatureComputes++;
      if (classifier.regime === "UNKNOWN") unknownComputes++;
      symbols[symbol] = {
        source: "deterministic_regime_classifier",
        dataQuality: symbolDataQuality,
        classifierRegime: classifier.regime,
        persistedRegime: persisted.regime,
        regime: row.regime,
        reliability: row.reliability,
        tradePermission: row.tradePermission,
        sourceLineage: row.sourceLineage,
        ts: row.ts,
        id: row.id,
      };
    }
  } catch (err) {
    return retryableFailure("regime_compute_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const dataQuality = jobDataQualitySummary({
    scope: "regime.compute",
    checkedAt: context.now().toISOString(),
    reports: dataQualityReports,
    symbolsChecked: payload.symbols.length,
    symbolsPassed: dataQualityReports.filter((report) => report.severity === "pass").length,
    symbolsWarned: dataQualityReports.filter((report) => report.severity === "warn").length,
    symbolsBlocked: dataQualityReports.filter((report) => report.severity === "block").length,
  });

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
    dataQuality,
    symbols,
  });
};
