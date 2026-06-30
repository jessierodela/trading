import type { JobPayload } from "@/lib/jobs/types";
import {
  combineDataQualityReports,
  createDataQualityReport,
  type DataQualityIssue,
  type DataQualityReport,
} from "@/lib/dataQuality/types";
import {
  missingFeatureReport,
  validateFeatureSnapshotQuality,
} from "@/lib/dataQuality/featureQuality";
import { closedBarAge, maxStalenessBarsFor } from "@/lib/dataQuality/freshness";
import { normalizeMarketIdentity } from "@/lib/dataQuality/marketIdentity";
import { jobDataQualitySummary } from "@/lib/dataQuality/qualityGate";
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
  const dataQualityReports: DataQualityReport[] = [];

  try {
    for (const symbol of payload.symbols) {
      const now = context.now();
      const expectedIdentity = normalizeMarketIdentity({
        symbol,
        exchange: payload.exchange,
        source: "coinbase",
      });
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
        const missingReport = missingFeatureReport({
          symbol,
          exchange: payload.exchange,
          timeframe: "1h",
          now,
          severity: "block",
        });
        dataQualityReports.push(missingReport);
        symbols[symbol] = {
          featuresRead: 0,
          signalsEvaluated: 0,
          inserted: 0,
          duplicatesSkipped: 0,
          skipped: true,
          skipReason: "feature_window_missing",
          dataQuality: missingReport,
        };
        continue;
      }

      const structuralReports = features.map((feature) =>
        validateFeatureSnapshotQuality({
          feature,
          expectedIdentity,
          timeframe: payload.timeframe,
          now,
          checkFreshness: false,
        })
      );
      const latestFeature = features.at(-1)!;
      const latestFeatureQuality = validateFeatureSnapshotQuality({
        feature: latestFeature,
        expectedIdentity,
        timeframe: payload.timeframe,
        now,
      });
      const latestDaily = dailyFeatures.at(-1) ?? null;
      const dailyQuality = latestDaily
        ? validateFeatureSnapshotQuality({
            feature: latestDaily,
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
      const regimeIssues: DataQualityIssue[] = [];
      let usableRegime = regime;
      if (regime) {
        const regimeAge = closedBarAge(regime.ts, "1h", now);
        const maxRegimeAge = maxStalenessBarsFor("1h");
        if (regimeAge !== null && regimeAge > maxRegimeAge) {
          regimeIssues.push({
            code: "REGIME_CONTEXT_STALE",
            severity: "warn",
            message: `Latest regime context is stale: age=${regimeAge} closed bars, max=${maxRegimeAge}.`,
            symbol,
            exchange: payload.exchange,
            timeframe: "1h",
            ts: regime.ts,
            expected: { maxStalenessBars: maxRegimeAge },
            actual: { ageClosedBars: regimeAge },
          });
          usableRegime = null;
        }
      }
      const regimeQuality = createDataQualityReport({
        scope: "strategies.evaluate.regime_context",
        checkedAt: now.toISOString(),
        symbol,
        exchange: payload.exchange,
        timeframe: "1h",
        issues: regimeIssues,
      });
      const symbolDataQuality = combineDataQualityReports({
        scope: "strategies.evaluate.symbol",
        checkedAt: now.toISOString(),
        reports: [...structuralReports, latestFeatureQuality, dailyQuality, regimeQuality],
        symbol,
        exchange: payload.exchange,
        timeframe: payload.timeframe,
      });
      dataQualityReports.push(symbolDataQuality);

      const hasBlockedWindow = structuralReports.some((report) => !report.ok) || !latestFeatureQuality.ok;
      if (hasBlockedWindow) {
        symbols[symbol] = {
          featuresRead: features.length,
          signalsEvaluated: 0,
          inserted: 0,
          duplicatesSkipped: 0,
          skipped: true,
          skipReason: "feature_window_data_quality_blocked",
          dataQuality: symbolDataQuality,
        };
        continue;
      }

      const dailyContextBlocked = dailyQuality.issues.some((issue) =>
        issue.severity === "block" ||
        issue.code === "FEATURE_MISSING" ||
        issue.code === "FEATURE_STALE" ||
        issue.code === "FEATURE_TIMESTAMP_INCOMPLETE"
      );
      const result = await runStrategyWindow({
        features,
        dailyFeatures: dailyContextBlocked ? [] : dailyFeatures,
        regimeByTs: () => usableRegime,
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
        dailyFeaturesRead: dailyFeatures.length,
        signalsEvaluated: filteredSignals.length,
        inserted: insertedForSymbol,
        duplicatesSkipped: duplicatesForSymbol,
        skipped: false,
        reducedDailyContext: dailyContextBlocked,
        dataQuality: symbolDataQuality,
      };
    }
  } catch (err) {
    return retryableFailure("strategies_evaluate_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const dataQuality = jobDataQualitySummary({
    scope: "strategies.evaluate",
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
    strategyIds: payload.strategyIds ?? "all",
    featuresRead,
    signalsEvaluated,
    inserted,
    duplicatesSkipped,
    byStrategy,
    dataQuality,
    symbols,
  });
};
