export type DataQualitySeverity = "pass" | "warn" | "block";

export interface DataQualityIssue {
  code: string;
  severity: DataQualitySeverity;
  message: string;
  symbol?: string;
  exchange?: string;
  source?: string;
  timeframe?: string;
  ts?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface DataQualityReport {
  ok: boolean;
  severity: DataQualitySeverity;
  checkedAt: string;
  scope: string;
  symbol?: string;
  exchange?: string;
  source?: string;
  timeframe?: string;
  issues: DataQualityIssue[];
  summary: {
    pass: number;
    warn: number;
    block: number;
  };
}

export function severityRank(severity: DataQualitySeverity): number {
  if (severity === "block") return 2;
  if (severity === "warn") return 1;
  return 0;
}

export function maxSeverity(severities: DataQualitySeverity[]): DataQualitySeverity {
  return severities.reduce<DataQualitySeverity>(
    (max, severity) => severityRank(severity) > severityRank(max) ? severity : max,
    "pass",
  );
}

export function summarizeIssues(issues: DataQualityIssue[]): DataQualityReport["summary"] {
  if (issues.length === 0) return { pass: 1, warn: 0, block: 0 };
  return {
    pass: 0,
    warn: issues.filter((issue) => issue.severity === "warn").length,
    block: issues.filter((issue) => issue.severity === "block").length,
  };
}

export function createDataQualityReport(input: {
  scope: string;
  checkedAt: string;
  issues?: DataQualityIssue[];
  symbol?: string;
  exchange?: string;
  source?: string;
  timeframe?: string;
}): DataQualityReport {
  const issues = input.issues ?? [];
  const severity = issues.length === 0
    ? "pass"
    : maxSeverity(issues.map((issue) => issue.severity));
  return {
    ok: severity !== "block",
    severity,
    checkedAt: input.checkedAt,
    scope: input.scope,
    symbol: input.symbol,
    exchange: input.exchange,
    source: input.source,
    timeframe: input.timeframe,
    issues,
    summary: summarizeIssues(issues),
  };
}

export function combineDataQualityReports(input: {
  scope: string;
  checkedAt: string;
  reports: DataQualityReport[];
  symbol?: string;
  exchange?: string;
  source?: string;
  timeframe?: string;
}): DataQualityReport {
  const issues = input.reports.flatMap((report) => report.issues);
  const severity = maxSeverity(input.reports.map((report) => report.severity));
  return {
    ok: !input.reports.some((report) => !report.ok),
    severity,
    checkedAt: input.checkedAt,
    scope: input.scope,
    symbol: input.symbol,
    exchange: input.exchange,
    source: input.source,
    timeframe: input.timeframe,
    issues,
    summary: input.reports.reduce<DataQualityReport["summary"]>(
      (summary, report) => ({
        pass: summary.pass + report.summary.pass,
        warn: summary.warn + report.summary.warn,
        block: summary.block + report.summary.block,
      }),
      { pass: 0, warn: 0, block: 0 },
    ),
  };
}

export function downgradeBlocksToWarn(report: DataQualityReport, codes?: string[]): DataQualityReport {
  const codeSet = codes ? new Set(codes) : null;
  return createDataQualityReport({
    scope: report.scope,
    checkedAt: report.checkedAt,
    symbol: report.symbol,
    exchange: report.exchange,
    source: report.source,
    timeframe: report.timeframe,
    issues: report.issues.map((issue) => {
      if (issue.severity !== "block") return issue;
      if (codeSet && !codeSet.has(issue.code)) return issue;
      return { ...issue, severity: "warn" };
    }),
  });
}
