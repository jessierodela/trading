import fs from "node:fs";
import path from "node:path";

interface ReportSpec {
  key: string;
  label: string;
  file: string;
  markdown: string;
  missingReason?: string;
}

interface TableData {
  headers: string[];
  rows: string[][];
}

const REPORT_DIR = path.join(process.cwd(), "reports", "p5");
const SECTION_TITLES = [
  "Strategy Refinement Candidate Comparison",
  "Strategy Refinement Candidate Results",
  "Cross-Asset Validated Candidate Summary",
  "Cross-Asset Router Validation Summary",
] as const;

const REQUIRED_REPORT_PATTERNS: Array<{ key: string; label: string; test: (file: string) => boolean }> = [
  { key: "baseline", label: "baseline", test: (file) => /^P5_MULTI_ASSET_STRATEGY_RESEARCH_REPORT_\d{8}-\d{6}\.md$/.test(file) },
  { key: "breakout8c", label: "breakout8c", test: (file) => file.includes("breakout8c") },
  { key: "trend8d", label: "trend8d", test: (file) => file.includes("trend8d") },
  { key: "mean8e", label: "mean8e", test: (file) => file.includes("mean8e") },
  { key: "results8f", label: "results8f", test: (file) => file.includes("results8f") },
  { key: "reporting-hardening", label: "reporting-hardening", test: (file) => file.includes("reporting-hardening") },
];

function timestampForFilename(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function loadReport(fileInput: string, fallbackLabel: string): ReportSpec {
  const fullPath = path.isAbsolute(fileInput) ? fileInput : path.resolve(process.cwd(), fileInput);
  const file = path.basename(fullPath);
  if (!fs.existsSync(fullPath)) {
    return {
      key: fallbackLabel,
      label: fallbackLabel,
      file,
      markdown: "",
      missingReason: `explicit report not found: ${fileInput}`,
    };
  }
  return {
    key: fallbackLabel,
    label: fallbackLabel,
    file,
    markdown: fs.readFileSync(fullPath, "utf8"),
  };
}

function explicitReportList(): ReportSpec[] | null {
  const raw = process.env.P5_COMPARE_REPORTS?.trim();
  if (!raw) return null;
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((file, index) => loadReport(file, `explicit-${index + 1}`));
}

function discoverReports(): ReportSpec[] {
  const explicit = explicitReportList();
  if (explicit) return explicit;

  const files = fs.existsSync(REPORT_DIR)
    ? fs.readdirSync(REPORT_DIR).filter((file) => file.endsWith(".md") && file.startsWith("P5_MULTI_ASSET_STRATEGY_RESEARCH_REPORT"))
    : [];

  return REQUIRED_REPORT_PATTERNS.map((pattern) => {
    const matches = files.filter(pattern.test).sort();
    const file = matches[matches.length - 1];
    if (!file) {
      return {
        key: pattern.key,
        label: pattern.label,
        file: "",
        markdown: "",
        missingReason: `no report matched expected snapshot '${pattern.label}'`,
      };
    }
    const fullPath = path.join(REPORT_DIR, file);
    return {
      key: pattern.key,
      label: pattern.label,
      file,
      markdown: fs.readFileSync(fullPath, "utf8"),
    };
  });
}

function extractSection(markdown: string, title: string): string | null {
  if (!markdown) return null;
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startMatch = markdown.match(new RegExp(`^(#{2,3}) ${escaped}\\s*$`, "m"));
  if (!startMatch || startMatch.index === undefined) return null;
  const level = startMatch[1].length;
  const start = startMatch.index;
  const rest = markdown.slice(start + startMatch[0].length);
  const next = rest.search(new RegExp(`^#{2,${level}} `, "m"));
  return `${"#".repeat(level)} ${title}${next === -1 ? rest : rest.slice(0, next)}`.trim();
}

function parseFirstTable(section: string | null): TableData | null {
  if (!section) return null;
  const lines = section.split(/\r?\n/);
  const headerIndex = lines.findIndex((line, index) =>
    line.trim().startsWith("|") &&
    lines[index + 1]?.trim().startsWith("|") &&
    /^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[index + 1].trim()),
  );
  if (headerIndex === -1) return null;
  const parseRow = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  const headers = parseRow(lines[headerIndex]);
  const rows: string[][] = [];
  for (let index = headerIndex + 2; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line.startsWith("|")) break;
    rows.push(parseRow(line));
  }
  return { headers, rows };
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function reportPathFor(report: ReportSpec): string {
  return report.file ? path.join("reports", "p5", report.file) : "missing";
}

function missingReports(reports: ReportSpec[]): ReportSpec[] {
  return reports.filter((report) => !report.markdown);
}

function missingReportsSection(reports: ReportSpec[]): string[] {
  const missing = missingReports(reports);
  return [
    "## Missing Snapshot Warnings",
    "",
    missing.length === 0
      ? "All expected report snapshots were found."
      : "WARNING: one or more expected report snapshots were missing. Extracted comparisons for those snapshots are incomplete.",
    "",
    ...(missing.length === 0
      ? []
      : missing.map((report) => `- ${report.label}: ${report.missingReason ?? "missing"}`)),
    missing.length === 0 ? "" : "",
  ];
}

function sectionAvailabilityRows(reports: ReportSpec[]): string[][] {
  return reports.map((report) => [
    report.label,
    reportPathFor(report),
    ...SECTION_TITLES.map((title) => extractSection(report.markdown, title) ? "yes" : "no"),
    extractSection(report.markdown, "Gate Availability Diagnostics") ? "yes" : "no",
  ]);
}

function selectedSectionExtracts(reports: ReportSpec[]): string[] {
  const out: string[] = [];
  for (const title of SECTION_TITLES) {
    out.push(`## ${title} Extracts`, "");
    for (const report of reports) {
      out.push(`### ${report.label}`, "");
      const section = extractSection(report.markdown, title);
      out.push(section ? section.replace(`## ${title}`, "").trim() : "_Section not present in this report._");
      out.push("");
    }
  }
  return out;
}

function gateDiagnosticsSummary(reports: ReportSpec[]): string[] {
  const report = reports.find((candidate) => extractSection(candidate.markdown, "Gate Availability Diagnostics")) ?? reports[reports.length - 1];
  const section = extractSection(report.markdown, "Gate Availability Diagnostics");
  const parsed = parseFirstTable(section);
  if (!parsed) {
    return [
      "## Non-Binding Gate Diagnostics Summary",
      "",
      "No Gate Availability Diagnostics table was found in the selected reports.",
      "",
    ];
  }

  const column = (name: string) => parsed.headers.findIndex((header) => header.toLowerCase() === name.toLowerCase());
  const strategyIndex = column("strategy");
  const gateIndex = column("gate");
  const passesIndex = column("passes");
  const failsIndex = column("fails");
  const unavailableIndex = column("unavailable passes");

  const enriched = parsed.rows.map((row) => {
    const passes = Number(row[passesIndex] ?? 0);
    const fails = Number(row[failsIndex] ?? 0);
    const unavailable = Number(row[unavailableIndex] ?? 0);
    const attempts = passes + fails;
    return {
      label: `${row[strategyIndex]} / ${row[gateIndex]}`,
      passes,
      fails,
      unavailable,
      failRate: attempts === 0 ? null : fails / attempts,
    };
  });

  const zeroFails = enriched.filter((row) => row.fails === 0);
  const highFail = enriched.filter((row) => row.failRate !== null && row.failRate > 0.9);
  const unavailable = enriched.filter((row) => row.unavailable > 0);

  const list = (rows: typeof enriched) => rows.length === 0
    ? ["- none"]
    : rows.map((row) => `- ${row.label}: passes=${row.passes}, fails=${row.fails}, unavailablePasses=${row.unavailable}, failRate=${row.failRate === null ? "n/a" : `${(row.failRate * 100).toFixed(2)}%`}`);

  return [
    "## Non-Binding Gate Diagnostics Summary",
    "",
    `Source report: \`${reportPathFor(report)}\`. These diagnostics are non-binding research checks; they summarize gate availability and selectivity but do not change strategy behavior or verdicts.`,
    "",
    "### Gates With 0 Fails",
    "",
    ...list(zeroFails),
    "",
    "### Gates With >90% Fail Rate",
    "",
    ...list(highFail),
    "",
    "### Gates With Unavailable Passes",
    "",
    ...list(unavailable),
    "",
  ];
}

function currentConclusion(): string[] {
  return [
    "## Current Conclusion",
    "",
    "- No refined strategy candidate should be treated as validated edge from the current report set.",
    "- `momentum_continuation_refined_v1` improved quality metrics but failed rolling-fold validation.",
    "- `trend_pullback_refined_v1` appears over-filtered and needs either looser research gates or more qualifying samples before any edge claim.",
    "- `breakout_expansion_refined_v1` remains not validated.",
    "- `mean_reversion_refined_v1` underperforms in the current held-out/refinement evidence.",
    "",
  ];
}

function priority8gImplementationCompletenessAudit(reports: ReportSpec[]): string[] {
  const hasSection = (title: string) => reports.some((report) => extractSection(report.markdown, title));
  const hasReport = (key: string) => reports.some((report) => report.key === key && !!report.markdown);
  const hasText = (needle: string) => reports.some((report) => report.markdown.includes(needle));
  const reportingHardening = reports.find((report) => report.key === "reporting-hardening" && !!report.markdown);
  const results8f = reports.find((report) => report.key === "results8f" && !!report.markdown);

  const rows = [
    [
      "Cross-Asset Opportunity Walk-Forward Validation exists",
      hasSection("Cross-Asset Opportunity Walk-Forward Validation") ? "complete" : "missing",
      hasSection("Cross-Asset Opportunity Walk-Forward Validation")
        ? "Cross-Asset Opportunity Walk-Forward Validation section extracted from versioned P5 reports"
        : "No matching section found",
      "Candidate-level validation is still directional and sample-limited",
      "Keep using held-out plus rolling folds before treating opportunities as edge",
    ],
    [
      "Reusable strategy refinement / gating framework exists",
      hasText("research-only strategy refinement variants") || hasText("Gate Availability Diagnostics") ? "complete" : "needs review",
      "Refined variants, gate diagnostics, and base-vs-refined report sections are present",
      "Gate diagnostics are report-level observability, not a replacement for causal strategy research",
      "Keep framework stable while planning v3 experiments",
    ],
    [
      "momentum_continuation_refined_v1 exists, is versioned, registered, and smoke-tested",
      hasText("momentum_continuation_refined_v1") ? "complete" : "missing",
      "Appears in refinement comparison/results, strategy versions, and momentum test-pass breakdown",
      "Improved quality metrics but failed rolling folds",
      "Keep as main v3 investigation candidate; do not promote",
    ],
    [
      "breakout_expansion_refined_v1 exists, is versioned, registered, and smoke-tested",
      hasText("breakout_expansion_refined_v1") ? "complete" : "missing",
      "Appears in breakout8c and later comparison reports",
      "Safer/lower frequency but not validated and weak on expectancy/PF",
      "Pause tuning unless specifically studying false-breakout reduction",
    ],
    [
      "trend_pullback_refined_v1 exists, is versioned, registered, and smoke-tested",
      hasText("trend_pullback_refined_v1") ? "complete" : "missing",
      "Appears in trend8d and later comparison reports",
      "Strong quality pocket but over-filtered with too few trades",
      "Plan v3 loosening experiment without touching router defaults",
    ],
    [
      "mean_reversion_refined_v1 exists, is versioned, registered, and smoke-tested",
      hasText("mean_reversion_refined_v1") ? "complete" : "missing",
      "Appears in mean8e and later comparison reports",
      "Current v2 underperforms in held-out/refinement evidence",
      "Rethink setup thesis before further tuning",
    ],
    [
      "Strategy Refinement Candidate Results exists",
      hasSection("Strategy Refinement Candidate Results") ? "complete" : "missing",
      results8f ? `Present from ${reportPathFor(results8f)} onward` : "No results8f/reporting-hardening section found",
      "Earlier snapshots do not contain this section by design",
      "Keep using latest report schema for future comparisons",
    ],
    [
      "Cross-report comparison exists",
      "complete",
      "This generated comparison report extracts the required cross-report sections",
      "Source versioned reports may remain local artifacts",
      "Keep comparison tooling and add machine-readable export",
    ],
    [
      "Base vs refined strategies are compared across assets, regimes, and walk-forward folds",
      hasSection("Strategy Refinement Candidate Comparison") && hasSection("Strategy Refinement Candidate Results") ? "complete" : "partial",
      "Comparison/results sections include multi-asset aggregate metrics, held-out candidate rows, and fold counts",
      "Candidate metrics are directional and not pooled proof by themselves",
      "Use pooled stats plus candidate rows together",
    ],
    [
      "Reporting separates hypothesis discovery from held-out/rolling validation",
      hasText("hypothesis") && hasText("held-out") ? "complete" : "needs review",
      "Reports label in-sample discovery, held-out tests, rolling folds, and conservative verdicts",
      "Markdown wording must stay disciplined as new experiments are added",
      "Preserve discovery-vs-validation language in every future report",
    ],
    [
      "No strategy/router/candidate is incorrectly promoted as production-valid edge",
      reportingHardening && !reportingHardening.markdown.includes("final verdict | VALIDATED") ? "complete" : "needs review",
      "Current conclusion states no validated edge and no router/default promotion",
      "This is a report audit, not a production safety control",
      "Keep promotion guardrails explicit until validation improves",
    ],
  ];

  return [
    "## Priority 8G Implementation Completeness Audit",
    "",
    table(["priority item", "status", "evidence", "remaining gap", "next action"], rows),
    "",
  ];
}

function priority8gNextRefinementPlan(): string[] {
  return [
    "## Priority 8G Next Refinement Plan",
    "",
    "### Momentum Continuation",
    "",
    "- Best balanced improvement among the refined variants.",
    "- Keep `momentum_continuation_refined_v1` as the main candidate for a future v3 investigation.",
    "- Do not promote yet because rolling folds failed.",
    "",
    "### Trend Pullback",
    "",
    "- Strongest quality pocket, but likely over-filtered.",
    "- Future v3 should test loosening gates carefully to increase trade count while preserving profit factor and drawdown behavior.",
    "",
    "### Breakout Expansion",
    "",
    "- Safer after refinement but still weak.",
    "- Pause further tuning unless specifically studying false-breakout reduction.",
    "",
    "### Mean Reversion",
    "",
    "- Current v2 underperforms.",
    "- Rethink setup logic before further tuning.",
    "- Do not simply loosen gates without a new thesis.",
    "",
  ];
}

function promotionGuardrails(): string[] {
  return [
    "## Promotion Guardrails",
    "",
    "- Do not promote any refined strategy into router defaults unless it passes held-out and rolling-fold validation.",
    "- Do not move to risk engine, paper trading, broker integration, order manager, or live execution based on current results.",
    "- Treat current findings as research hypotheses only.",
    "- Require more windows, more assets, and stronger fold consistency before production conclusions.",
    "",
  ];
}

function recommendedNextEngineeringTasks(): string[] {
  return [
    "## Recommended Next Engineering Tasks",
    "",
    "- Keep strict/missing-source warnings in `compareP5RefinementReports.ts`; this is already implemented via missing snapshot warnings, `COMPARE_P5_STRICT=1`, and optional `P5_COMPARE_REPORTS`.",
    "- Keep report comparison tooling as part of the research workflow.",
    "- Add optional CSV/JSON summary export from the comparison report so future analysis can be parsed without scraping Markdown.",
    "- Add daily feature readiness before equity/ETF expansion.",
    "- Add equity/ETF ingestion later for SPY, QQQ, AAPL, MSFT, and NVDA.",
    "- Plan, but do not implement yet, Momentum v3 and Trend Pullback v3 experiments.",
    "",
  ];
}

function regimeClarificationNote(): string[] {
  return [
    "## Regime Interpretation Note",
    "",
    "The regime label on each selected research window is the dominant-window regime used for sampling and aggregation. Refined strategy gates still evaluate bar-level regime context at the individual signal timestamp. A strategy can therefore be evaluated inside a TREND_UP-dominant window while its own gate accepts or rejects a specific bar using the latest persisted/proxy regime label for that bar.",
    "",
  ];
}

function main(): void {
  const reports = discoverReports();
  const missing = missingReports(reports);
  for (const report of missing) {
    console.warn(`[compare:p5] WARNING missing ${report.label}: ${report.missingReason ?? "missing"}`);
  }
  if (process.env.COMPARE_P5_STRICT === "1" && missing.length > 0) {
    throw new Error(`COMPARE_P5_STRICT=1 and missing required reports: ${missing.map((report) => report.label).join(", ")}`);
  }
  const generatedAt = new Date().toISOString();
  const outputPath = path.join(REPORT_DIR, `P5_REFINEMENT_COMPARISON_${timestampForFilename()}.md`);

  const markdown = [
    "# P5 Refinement Cross-Report Comparison Summary",
    "",
    `Generated: ${generatedAt}`,
    "",
    "Note: source versioned P5 reports are local research artifacts and may not be committed to git. This comparison stores the extracted sections needed for review.",
    "",
    "## Compared Reports",
    "",
    table(
      ["label", "report", ...SECTION_TITLES, "Gate Availability Diagnostics"],
      sectionAvailabilityRows(reports),
    ),
    "",
    ...missingReportsSection(reports),
    ...currentConclusion(),
    ...priority8gImplementationCompletenessAudit(reports),
    ...priority8gNextRefinementPlan(),
    ...promotionGuardrails(),
    ...recommendedNextEngineeringTasks(),
    ...regimeClarificationNote(),
    ...gateDiagnosticsSummary(reports),
    ...selectedSectionExtracts(reports),
  ].join("\n");

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(outputPath, markdown);
  console.log(`wrote ${outputPath}`);
}

main();
