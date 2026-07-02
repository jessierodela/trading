/**
 * _smoke/systemState.ts
 *
 * Offline checks for the dashboard system-state composition
 * (lib/ops/systemState.ts) and the honesty invariants it must uphold:
 * unknown is never rendered as healthy, static content is always classified,
 * and live execution is always reported as disabled.
 *
 * Run: npm run smoke:system-state
 */
import fs from "node:fs";
import path from "node:path";
import type { P8OpsSummary } from "@/lib/ops/p8Types";
import { buildRiskGateSummary } from "@/lib/ops/riskGateSummary";
import { buildSystemState, nextHourlyFeedAt } from "@/lib/ops/systemState";

let failed = 0;

function assert(label: string, condition: boolean, details?: unknown): void {
  if (condition) {
    console.log(`PASS: ${label}`);
    return;
  }
  console.log(`FAIL: ${label}`);
  if (details !== undefined) console.log("       ", details);
  failed++;
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const matches = JSON.stringify(actual) === JSON.stringify(expected);
  assert(label, matches, matches ? undefined : { actual, expected });
}

function readText(file: string): string {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

const NOW = new Date("2026-07-01T12:30:00.000Z");
const FRESH = "2026-07-01T12:10:00.000Z"; // 20 minutes before NOW
const OLD = "2026-07-01T08:00:00.000Z";   // 4.5 hours before NOW

function opsSummary(overrides: {
  stageStatus?: Partial<Record<string, { status: string; completedAt?: string | null; failedAt?: string | null; error?: string | null }>>;
  counts?: Partial<Record<string, number>>;
  secretPresent?: boolean;
  snapshot?: { generatedAt: string; isExpired: boolean } | null;
  staleSymbols?: string[];
} = {}): P8OpsSummary {
  const stageNames = [
    "market.ingest.latest",
    "features.compute",
    "regime.compute",
    "strategies.evaluate",
    "paper.monitor",
    "dashboard.snapshot",
  ] as const;

  const snapshotInput = overrides.snapshot === undefined
    ? { generatedAt: FRESH, isExpired: false }
    : overrides.snapshot;

  return {
    generatedAt: NOW.toISOString(),
    scheduler: {
      routePath: "/api/jobs/schedule",
      cronExpression: "5 * * * *",
      cronMeaning: "hourly at minute 5",
      schedulerSecretPresent: overrides.secretPresent ?? true,
      externalSchedulerVerified: "unknown",
      lastScheduledFeed: null,
    },
    queue: {
      counts: {
        queued: overrides.counts?.queued ?? 0,
        running: overrides.counts?.running ?? 0,
        succeeded: overrides.counts?.succeeded ?? 6,
        failed: overrides.counts?.failed ?? 0,
        cancelled: overrides.counts?.cancelled ?? 0,
        dead: overrides.counts?.dead ?? 0,
      },
      recentWindowHours: 24,
      oldestQueuedAgeSeconds: null,
      expiredLeaseCount: 0,
      latestJobEventAt: FRESH,
      recentJobs: [],
    },
    worker: {
      status: "recently_active",
      lastClaimedJob: null,
      lastCompletedJob: null,
      lastHeartbeatOrLeaseAt: FRESH,
      recommendation: "worker is keeping up",
    },
    pipeline: {
      stages: stageNames.map((stage) => {
        const override = overrides.stageStatus?.[stage];
        const status = (override?.status ?? "succeeded") as P8OpsSummary["pipeline"]["stages"][number]["status"];
        const completedAt = override?.completedAt !== undefined ? override.completedAt : (status === "succeeded" ? FRESH : null);
        return {
          stage,
          status,
          publicId: null,
          attempts: 1,
          maxAttempts: 3,
          startedAt: completedAt,
          completedAt,
          failedAt: override?.failedAt ?? null,
          durationMs: 1200,
          resultSummary: null,
          error: override?.error ?? null,
          runAfter: null,
          createdAt: completedAt ?? FRESH,
        };
      }),
    },
    snapshot: {
      signalsSource: snapshotInput === null ? "empty" : "dashboard_snapshots",
      latestDashboardSnapshot: snapshotInput === null ? null : {
        publicId: "22222222-2222-4222-8222-222222222222",
        generatedAt: snapshotInput.generatedAt,
        expiresAt: null,
        isExpired: snapshotInput.isExpired,
        sourceJobPublicId: null,
        payloadSummary: { agentResultsCount: 6, activityCount: 3, confluenceCount: 1, symbols: ["BTC-USD"] },
      },
    },
    regime: {
      symbols: ["BTC-USD", "ETH-USD"].map((symbol) => ({
        symbol,
        regime: "CHOP",
        reliability: 0.7,
        timestamp: FRESH,
        source: "regime_snapshots",
        stale: (overrides.staleSymbols ?? []).includes(symbol),
      })),
    },
    readiness: [
      { label: "no live execution", status: "pass", detail: "forbidden job types rejected" },
    ],
  };
}

// ── 1. Fully unavailable state ────────────────────────────────────────────────

function runUnavailableChecks(): void {
  console.log("\n=== fully unavailable state ===");
  const state = buildSystemState({
    now: NOW,
    ops: null,
    opsReason: "database unavailable: SUPABASE_DB_URL missing",
    riskGate: null,
    riskGateReason: "database unavailable",
  });

  eq("ops reported unavailable with reason", state.ops, {
    available: false,
    reason: "database unavailable: SUPABASE_DB_URL missing",
    summary: null,
  });
  assert("risk gate reported unavailable", !state.riskGate.available);

  const jobBacked = state.flow.filter((stage) => stage.jobType !== null);
  assert(
    "all job-backed stages are unknown, none healthy",
    jobBacked.every((stage) => stage.status === "unknown" && stage.dataReality === "unavailable"),
    jobBacked.map((stage) => `${stage.key}:${stage.status}`),
  );
  const riskStage = state.flow.find((stage) => stage.key === "risk_gate");
  eq("risk gate stage is unknown", riskStage?.status, "unknown");
  const alerts = state.flow.find((stage) => stage.key === "alerts_reports");
  eq("alerts stage is always disabled", alerts?.status, "disabled");

  eq("first attention item is critical ops outage", state.attention[0]?.severity, "critical");
  assert(
    "attention explains the unknown state",
    state.attention[0]?.detail.includes("SUPABASE_DB_URL missing") === true,
  );
  assert(
    "truthfulness marks operations state missing",
    state.truthfulness.some((entry) => entry.area.startsWith("Operations state") && entry.reality === "missing"),
  );
}

// ── 2. Healthy state ──────────────────────────────────────────────────────────

function runHealthyChecks(): void {
  console.log("\n=== healthy state ===");
  const riskGate = buildRiskGateSummary({
    now: NOW,
    counts: [
      { approved: true, count: 2 },
      { approved: false, count: 5 },
    ],
    blockedByRows: [{ blocked_by: ["REGIME_BLOCKED"] }, { blocked_by: ["REGIME_BLOCKED", "SIGNAL_STALE"] }],
  });
  const state = buildSystemState({ now: NOW, ops: opsSummary(), riskGate });

  eq(
    "flow order is the eight conceptual stages",
    state.flow.map((stage) => stage.key),
    [
      "market_ingest",
      "feature_snapshots",
      "regime_compute",
      "strategy_evaluation",
      "risk_gate",
      "paper_monitor",
      "dashboard_snapshots",
      "alerts_reports",
    ],
  );
  assert(
    "fresh succeeded stages are healthy with real data",
    state.flow
      .filter((stage) => ["market_ingest", "feature_snapshots", "regime_compute"].includes(stage.key))
      .every((stage) => stage.status === "healthy" && stage.dataReality === "real" && stage.lastSuccessAt === FRESH),
  );
  const riskStage = state.flow.find((stage) => stage.key === "risk_gate");
  eq("risk gate stage healthy with evaluations", [riskStage?.status, riskStage?.dataReality], ["healthy", "real"]);
  assert("risk gate note carries evaluated counts", riskStage?.note.includes("7 evaluated") === true, riskStage?.note);

  eq("no issues collapses to a single info item", [state.attention.length, state.attention[0]?.severity], [1, "info"]);
  assert(
    "truthfulness marks signals payload real",
    state.truthfulness.some((entry) => entry.area.includes("/api/signals") && entry.reality === "real"),
  );
}

// ── 3. Degraded states ────────────────────────────────────────────────────────

function runDegradedChecks(): void {
  console.log("\n=== degraded states ===");

  const staleState = buildSystemState({
    now: NOW,
    ops: opsSummary({
      stageStatus: { "features.compute": { status: "succeeded", completedAt: OLD } },
      snapshot: { generatedAt: OLD, isExpired: true },
      staleSymbols: ["ETH-USD"],
      secretPresent: false,
    }),
    riskGate: buildRiskGateSummary({ now: NOW }),
  });

  const features = staleState.flow.find((stage) => stage.key === "feature_snapshots");
  eq("old success becomes stale, not healthy", [features?.status, features?.dataReality], ["stale", "stale"]);
  const snapshots = staleState.flow.find((stage) => stage.key === "dashboard_snapshots");
  eq("expired snapshot stage is stale", snapshots?.status, "stale");
  assert(
    "missing scheduler secret raises attention",
    staleState.attention.some((item) => item.title.includes("SCHEDULER_SECRET")),
  );
  assert(
    "stale regime raises attention naming the symbol",
    staleState.attention.some((item) => item.detail.includes("ETH-USD")),
  );
  const zeroGate = staleState.flow.find((stage) => stage.key === "risk_gate");
  eq("risk gate with zero evaluations shows no data, not fake activity", zeroGate?.dataReality, "unavailable");

  const brokenState = buildSystemState({
    now: NOW,
    ops: opsSummary({
      stageStatus: { "strategies.evaluate": { status: "dead", failedAt: FRESH, error: "boom" } },
      counts: { dead: 1, failed: 2 },
    }),
    riskGate: null,
    riskGateReason: "query timeout",
  });

  const strategies = brokenState.flow.find((stage) => stage.key === "strategy_evaluation");
  eq("dead stage is blocked with its error", [strategies?.status, strategies?.error], ["blocked", "boom"]);
  assert(
    "attention is sorted most severe first",
    brokenState.attention.every((item, i, arr) => {
      const rank = { critical: 0, warning: 1, info: 2 } as const;
      return i === 0 || rank[arr[i - 1].severity] <= rank[item.severity];
    }),
    brokenState.attention.map((item) => item.severity),
  );
  assert(
    "dead jobs raise critical attention",
    brokenState.attention.some((item) => item.severity === "critical" && item.title.includes("dead-lettered")),
  );
}

// ── 4. Invariants ─────────────────────────────────────────────────────────────

function runInvariantChecks(): void {
  console.log("\n=== honesty invariants ===");

  const states = [
    buildSystemState({ now: NOW, ops: null, riskGate: null }),
    buildSystemState({ now: NOW, ops: opsSummary(), riskGate: buildRiskGateSummary({ now: NOW }) }),
  ];

  for (const [i, state] of states.entries()) {
    assert(
      `state ${i}: live execution is always reported disabled`,
      state.execution.liveExecutionDisabled === true && state.execution.forbiddenJobTypes.length > 0,
    );
    assert(
      `state ${i}: truthfulness always classifies static reference panels`,
      state.truthfulness.some((entry) => entry.reality === "static"),
    );
    assert(
      `state ${i}: truthfulness always reports live execution disabled`,
      state.truthfulness.some((entry) => entry.area === "Live trade execution" && entry.reality === "disabled"),
    );
    assert(
      `state ${i}: attention list is never empty`,
      state.attention.length > 0,
    );
    assert(
      `state ${i}: no unknown stage claims real data`,
      state.flow.every((stage) => stage.status !== "unknown" || stage.dataReality === "unavailable"),
    );
  }

  eq("next feed from 12:30 is 13:05", nextHourlyFeedAt(new Date("2026-07-01T12:30:00.000Z")), "2026-07-01T13:05:00.000Z");
  eq("next feed from 12:04 is 12:05", nextHourlyFeedAt(new Date("2026-07-01T12:04:59.000Z")), "2026-07-01T12:05:00.000Z");
  eq("next feed from exactly 12:05 is 13:05", nextHourlyFeedAt(new Date("2026-07-01T12:05:00.000Z")), "2026-07-01T13:05:00.000Z");
}

// ── 5. Static boundaries ──────────────────────────────────────────────────────

function runStaticBoundaryChecks(): void {
  console.log("\n=== static boundaries ===");

  const route = readText("app/api/ops/system-state/route.ts");
  const routeCode = route.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
  assert("system-state route composes via loadSystemState", route.includes("loadSystemState"));
  assert(
    "system-state route is read-only (no enqueue, no insert/update)",
    !/enqueue|INSERT|UPDATE|DELETE/i.test(routeCode),
  );
  assert("system-state route never 503s — availability is state", !routeCode.includes("503"));

  const lib = readText("lib/ops/systemState.ts");
  assert("system-state lib issues no SQL of its own", !/pool\.query|select\s/i.test(lib));
  assert("system-state lib does not import the worker", !lib.includes("lib/jobs/worker"));

  const page = readText("app/dashboard/page.tsx");
  assert(
    "dashboard page no longer renders the deleted static panels",
    !/SystemStatusGrid|DataHealthPanel|SystemEventLog|ExecutionReadinessPanel|DashboardHero/.test(page),
  );
  assert("dashboard page renders the how-to-read glossary", page.includes("HowToReadPanel"));
  assert("static reference panels are grouped behind the labeled wrapper", page.includes("ArchitectureReference"));
}

function main(): void {
  runUnavailableChecks();
  runHealthyChecks();
  runDegradedChecks();
  runInvariantChecks();
  runStaticBoundaryChecks();
  console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
