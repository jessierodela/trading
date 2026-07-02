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
import {
  buildDerivedSourceLineage,
  sourceLineageFromFeature,
  sourceLineageQualityReport,
} from "@/lib/market/sourceLineage";
import type { Exchange, StrategySignal } from "@/lib/quant/types";
import { getStrategyById } from "@/lib/strategies/strategyRegistry";
import { runStrategyWindow } from "@/lib/strategies/runStrategyWindow";
import {
  isActionableTriggerSignal,
  runScheduledRiskGate,
  type StrategiesRiskGateServices,
} from "./strategiesRiskGate";
import {
  handlerSuccess,
  invalidPayload,
  requireService,
  retryableFailure,
  type JobHandler,
  type JobHandlerContext,
} from "./types";

const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DAILY_LOOKBACK_MS = 60 * 24 * 60 * 60 * 1000;

function isExchange(value: string): value is Exchange {
  return value === "COINBASE" || value === "BINANCE" || value === "POLYGON";
}

function isDuplicateInsert(err: unknown): boolean {
  return err instanceof Error && /duplicate|unique|strategy_signals_unique/i.test(err.message);
}

/**
 * Lazily resolves the P11 risk-gate services so jobs that never emit a
 * trigger signal (e.g. all-setup windows) never require paperStore /
 * intentStore / riskDecisionStore to be wired.
 */
function makeRiskGateServicesResolver(context: JobHandlerContext): () => StrategiesRiskGateServices {
  let cached: StrategiesRiskGateServices | null = null;
  return () => {
    if (!cached) {
      cached = {
        paperStore: requireService(context.services, "paperStore"),
        intentStore: requireService(context.services, "intentStore"),
        riskDecisionStore: requireService(context.services, "riskDecisionStore"),
      };
    }
    return cached;
  };
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
  let riskEvaluated = 0;
  let riskApproved = 0;
  let riskRejected = 0;
  let riskDuplicateDecisions = 0;
  let tradeIntentsCreated = 0;
  const byStrategy: Record<string, number> = {};
  const symbols: Record<string, unknown> = {};
  const dataQualityReports: DataQualityReport[] = [];
  const getRiskGateServices = makeRiskGateServicesResolver(context);

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
      const lineageReport = sourceLineageQualityReport({
        scope: "strategies.evaluate.source_lineage",
        checkedAt: now.toISOString(),
        expectedIdentity,
        lineages: [
          ...features.map((feature) => feature.sourceLineage),
          latestDaily?.sourceLineage,
        ],
        symbol,
        exchange: payload.exchange,
        timeframe: payload.timeframe,
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
        reports: [...structuralReports, latestFeatureQuality, dailyQuality, regimeQuality, lineageReport],
        symbol,
        exchange: payload.exchange,
        timeframe: payload.timeframe,
      });
      dataQualityReports.push(symbolDataQuality);

      const hasBlockedWindow =
        structuralReports.some((report) => !report.ok) ||
        !latestFeatureQuality.ok ||
        !lineageReport.ok;
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
      const lineagedSignals = filteredSignals.map((signal) => ({
        ...signal,
        sourceLineage: buildDerivedSourceLineage({
          kind: "strategy_signal",
          source: "strategies.evaluate",
          transform: signal.strategyId,
          transformedAt: signal.ts,
          identity: expectedIdentity,
          inputSources: [sourceLineageFromFeature(signal.features)],
          featureVersion: signal.featureVersion,
          strategyVersion: signal.strategyVersion,
          notes: dailyContextBlocked ? ["reduced_daily_context"] : ["daily_context_included"],
        }),
      }));
      let insertedForSymbol = 0;
      let duplicatesForSymbol = 0;
      let riskEvaluatedForSymbol = 0;
      let riskApprovedForSymbol = 0;
      let riskRejectedForSymbol = 0;
      let tradeIntentsCreatedForSymbol = 0;
      for (const signal of lineagedSignals) {
        let persistedSignal: (StrategySignal & { id: number }) | null = null;
        try {
          persistedSignal = await signalStore.insert(signal);
          inserted++;
          insertedForSymbol++;
        } catch (err) {
          if (!isDuplicateInsert(err)) throw err;
          duplicatesSkipped++;
          duplicatesForSymbol++;
          persistedSignal = await signalStore.fetchBySignature({
            symbol: signal.symbol,
            exchange: signal.exchange,
            timeframe: signal.timeframe,
            ts: signal.ts,
            strategyId: signal.strategyId,
            strategyVersion: signal.strategyVersion,
          });
        }
        byStrategy[signal.strategyId] = (byStrategy[signal.strategyId] ?? 0) + 1;

        if (persistedSignal && isActionableTriggerSignal(persistedSignal)) {
          const gate = await runScheduledRiskGate(
            persistedSignal,
            usableRegime,
            getRiskGateServices(),
            { now: context.now },
          );
          if (gate.evaluated) {
            riskEvaluated++;
            riskEvaluatedForSymbol++;
            if (!gate.isNewDecision) riskDuplicateDecisions++;
            if (gate.approved === true) {
              riskApproved++;
              riskApprovedForSymbol++;
            } else if (gate.approved === false) {
              riskRejected++;
              riskRejectedForSymbol++;
            }
            if (gate.intentCreated) {
              tradeIntentsCreated++;
              tradeIntentsCreatedForSymbol++;
            }
          }
        }
      }
      featuresRead += result.featuresRead;
      signalsEvaluated += lineagedSignals.length;
      symbols[symbol] = {
        featuresRead: result.featuresRead,
        dailyFeaturesRead: dailyFeatures.length,
        signalsEvaluated: lineagedSignals.length,
        inserted: insertedForSymbol,
        duplicatesSkipped: duplicatesForSymbol,
        skipped: false,
        reducedDailyContext: dailyContextBlocked,
        dataQuality: symbolDataQuality,
        riskGate: {
          evaluated: riskEvaluatedForSymbol,
          approved: riskApprovedForSymbol,
          rejected: riskRejectedForSymbol,
          tradeIntentsCreated: tradeIntentsCreatedForSymbol,
        },
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
    riskGate: {
      evaluated: riskEvaluated,
      approved: riskApproved,
      rejected: riskRejected,
      duplicateDecisionsSkipped: riskDuplicateDecisions,
      tradeIntentsCreated,
    },
    symbols,
  });
};
