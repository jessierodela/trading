import { computeFeaturesLatest } from "@/lib/features/engine";
import type { JobPayload } from "@/lib/jobs/types";
import { validateBarQuality } from "@/lib/dataQuality/barQuality";
import { normalizeMarketIdentity } from "@/lib/dataQuality/marketIdentity";
import { jobDataQualitySummary } from "@/lib/dataQuality/qualityGate";
import type { DataQualityReport } from "@/lib/dataQuality/types";
import type { Exchange } from "@/lib/quant/types";
import { FEATURE_VERSION } from "@/lib/versions";
import {
  handlerFailure,
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
  const dataQualityReports: DataQualityReport[] = [];
  let checkedBars = 0;
  let passedBars = 0;
  let warnedBars = 0;
  let blockedBars = 0;

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

      const expectedIdentity = normalizeMarketIdentity({
        symbol,
        exchange: payload.exchange,
      });
      const reports = bars.map((bar) =>
        validateBarQuality({
          bar,
          expectedIdentity,
          timeframe: payload.timeframe,
          now: context.now(),
          closedBarsOnly: true,
          volumePolicy: "required",
          source: "unknown",
        })
      );
      const usableBars = bars.filter((_, index) => reports[index].severity !== "block");
      const blockedForSymbol = reports.filter((report) => report.severity === "block").length;
      const warnedForSymbol = reports.filter((report) => report.severity === "warn").length;
      const passedForSymbol = reports.filter((report) => report.severity === "pass").length;
      const symbolDataQuality = jobDataQualitySummary({
        scope: "features.compute.symbol",
        checkedAt: context.now().toISOString(),
        reports,
        checkedBars: bars.length,
        passedBars: passedForSymbol,
        warnedBars: warnedForSymbol,
        blockedBars: blockedForSymbol,
      });
      if (usableBars.length === 0) {
        return handlerFailure("features_compute_data_quality_blocked", false, {
          symbol,
          exchange: payload.exchange,
          timeframe: payload.timeframe,
          dataQuality: symbolDataQuality,
        });
      }

      const computed = computeFeaturesLatest(usableBars);
      const insertedForSymbol = await featureStore.insertMany(computed.rows);
      barsRead += bars.length;
      featuresComputed += computed.rows.length;
      inserted += insertedForSymbol;
      dataQualityReports.push(symbolDataQuality);
      checkedBars += bars.length;
      passedBars += passedForSymbol;
      warnedBars += warnedForSymbol;
      blockedBars += blockedForSymbol;
      symbols[symbol] = {
        barsRead: bars.length,
        usableBars: usableBars.length,
        featuresComputed: computed.rows.length,
        inserted: insertedForSymbol,
        seriesStartTs: computed.seriesStartTs,
        seriesEndTs: computed.seriesEndTs,
        droppedPreGapCount: computed.droppedPreGapCount,
        dataQuality: symbolDataQuality,
      };
    }
  } catch (err) {
    return retryableFailure("features_compute_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const dataQuality = jobDataQualitySummary({
    scope: "features.compute",
    checkedAt: context.now().toISOString(),
    reports: dataQualityReports,
    checkedBars,
    passedBars,
    warnedBars,
    blockedBars,
  });

  return handlerSuccess({
    jobType: payload.jobType,
    exchange: payload.exchange,
    timeframe: payload.timeframe,
    featureVersion: payload.featureVersion,
    barsRead,
    featuresComputed,
    inserted,
    duplicatesSkipped: featuresComputed - inserted,
    dataQuality,
    symbols,
  });
};
