import fs from "node:fs";
import path from "node:path";

interface ReportSpec {
  key: string;
  label: string;
  file: string;
  markdown: string;
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

function discoverReports(): ReportSpec[] {
  const files = fs.existsSync(REPORT_DIR)
    ? fs.readdirSync(REPORT_DIR).filter((file) => file.endsWith(".md") && file.startsWith("P5_MULTI_ASSET_STRATEGY_RESEARCH_REPORT"))
    : [];

  const patterns: Array<{ key: string; label: string; test: (file: string) => boolean }> = [
    { key: "baseline", label: "baseline", test: (file) => /^P5_MULTI_ASSET_STRATEGY_RESEARCH_REPORT_\d{8}-\d{6}\.md$/.test(file) },
    { key: "breakout8c", label: "breakout8c", test: (file) => file.includes("breakout8c") },
    { key: "trend8d", label: "trend8d", test: (file) => file.includes("trend8d") },
    { key: "mean8e", label: "mean8e", test: (file) => file.includes("mean8e") },
    { key: "results8f", label: "results8f", test: (file) => file.includes("results8f") },
    { key: "reporting-hardening", label: "reporting-hardening", test: (file) => file.includes("reporting-hardening") },
  ];

  return patterns.map((pattern) => {
    const matches = files.filter(pattern.test).sort();
    const file = matches[matches.length - 1];
    if (!file) {
      return { key: pattern.key, label: pattern.label, file: "", markdown: "" };
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
  const startMatch = markdown.match(new RegExp(`^## ${escaped}\\s*$`, "m"));
  if (!startMatch || startMatch.index === undefined) return null;
  const start = startMatch.index;
  const rest = markdown.slice(start + startMatch[0].length);
  const next = rest.search(/^## /m);
  return `## ${title}${next === -1 ? rest : rest.slice(0, next)}`.trim();
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
  const generatedAt = new Date().toISOString();
  const outputPath = path.join(REPORT_DIR, `P5_REFINEMENT_COMPARISON_${timestampForFilename()}.md`);

  const markdown = [
    "# P5 Refinement Cross-Report Comparison Summary",
    "",
    `Generated: ${generatedAt}`,
    "",
    "## Compared Reports",
    "",
    table(
      ["label", "report", ...SECTION_TITLES, "Gate Availability Diagnostics"],
      sectionAvailabilityRows(reports),
    ),
    "",
    ...currentConclusion(),
    ...regimeClarificationNote(),
    ...gateDiagnosticsSummary(reports),
    ...selectedSectionExtracts(reports),
  ].join("\n");

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(outputPath, markdown);
  console.log(`wrote ${outputPath}`);
}

main();
