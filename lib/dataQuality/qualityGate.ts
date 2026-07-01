import type { DataQualityIssue, DataQualityReport, DataQualitySeverity } from "./types";
import { combineDataQualityReports, createDataQualityReport, maxSeverity } from "./types";

export class DataQualityGateError extends Error {
  constructor(
    message: string,
    public readonly report: DataQualityReport,
    public readonly code = "data_quality_blocked",
  ) {
    super(message);
    this.name = "DataQualityGateError";
  }
}

export function isDataQualityGateError(err: unknown): err is DataQualityGateError {
  return err instanceof DataQualityGateError;
}

export function createIssue(input: DataQualityIssue): DataQualityIssue {
  return input;
}

export function blockedByReport(report: DataQualityReport): boolean {
  return report.issues.some((issue) => issue.severity === "block");
}

export function compactQualityReport(report: DataQualityReport): {
  ok: boolean;
  severity: DataQualitySeverity;
  checkedAt: string;
  scope: string;
  symbol?: string;
  exchange?: string;
  source?: string;
  timeframe?: string;
  issues: DataQualityIssue[];
  summary: DataQualityReport["summary"];
} {
  return report;
}

export function jobDataQualitySummary(input: {
  checkedAt: string;
  scope: string;
  reports: DataQualityReport[];
  symbolsChecked?: number;
  symbolsPassed?: number;
  symbolsWarned?: number;
  symbolsBlocked?: number;
  checkedBars?: number;
  passedBars?: number;
  warnedBars?: number;
  blockedBars?: number;
}): DataQualityReport & {
  symbolsChecked: number;
  symbolsPassed: number;
  symbolsWarned: number;
  symbolsBlocked: number;
  checkedBars: number;
  passedBars: number;
  warnedBars: number;
  blockedBars: number;
} {
  const report = input.reports.length === 0
    ? createDataQualityReport({ scope: input.scope, checkedAt: input.checkedAt })
    : combineDataQualityReports({
        scope: input.scope,
        checkedAt: input.checkedAt,
        reports: input.reports,
      });
  return {
    ...report,
    symbolsChecked: input.symbolsChecked ?? 0,
    symbolsPassed: input.symbolsPassed ?? 0,
    symbolsWarned: input.symbolsWarned ?? 0,
    symbolsBlocked: input.symbolsBlocked ?? 0,
    checkedBars: input.checkedBars ?? 0,
    passedBars: input.passedBars ?? 0,
    warnedBars: input.warnedBars ?? 0,
    blockedBars: input.blockedBars ?? 0,
  };
}

export function severityFromReports(reports: DataQualityReport[]): DataQualitySeverity {
  return maxSeverity(reports.map((report) => report.severity));
}
