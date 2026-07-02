"use client";

import type { SystemStateResponse } from "@/lib/ops/systemState";
import { PHASES, PLATFORM_DESCRIPTION, phaseTone } from "./overviewContent";

interface PaperSummarySnapshot {
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  totalFees: number;
  winCount: number;
  lossCount: number;
  winRatePct: number | null;
  maxDrawdown: number | null;
  openExposure: number;
  closedTradeCount: number;
}

interface OverviewSectionProps {
  state: SystemStateResponse | null;
  fetchError: string | null;
  paperSummary: PaperSummarySnapshot;
  onReviewItems: () => void;
}

const trackedFlowKeys = new Set([
  "market_ingest",
  "feature_snapshots",
  "regime_compute",
  "strategy_evaluation",
  "risk_gate",
  "paper_monitor",
]);

const verdictToneClass = {
  healthy: "bg-[var(--color-accent-green)] ring-[6px] ring-[var(--color-accent-green)]/15",
  warning: "bg-[var(--color-accent-amber)] ring-[6px] ring-[var(--color-accent-amber)]/15",
  critical: "bg-[var(--color-accent-red)] ring-[6px] ring-[var(--color-accent-red)]/15",
} as const;

function formatCurrency(value: number): string {
  const sign = value < 0 ? "-" : value > 0 ? "+" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatAgeFromNow(iso: string | null, generatedAt: string | null): string {
  if (!iso || !generatedAt) return "unknown";
  const start = new Date(iso).getTime();
  const end = new Date(generatedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "unknown";
  const hours = (end - start) / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export function OverviewSection({ state, fetchError, paperSummary, onReviewItems }: OverviewSectionProps) {
  const trackedFlow = state?.flow.filter((stage) => trackedFlowKeys.has(stage.key)) ?? [];
  const openAttention = state?.attention.filter((item) => item.severity !== "info").length ?? 0;
  const criticalAttention = state?.attention.some((item) => item.severity === "critical") ?? false;
  const blockedFlow = trackedFlow.some((stage) => stage.status === "blocked");
  const staleStage = trackedFlow.find((stage) => stage.status === "stale" || stage.status === "warning" || stage.status === "unknown");
  const healthyStages = trackedFlow.filter((stage) => stage.status === "healthy").length;
  const totalStages = state ? trackedFlow.length + 1 : 7;
  const pipelineValue = state ? `${healthyStages}/${totalStages}` : "--/7";
  const generatedAt = state?.generatedAt ?? null;
  const netPnl = paperSummary.totalRealizedPnl + paperSummary.totalUnrealizedPnl;
  const verdictTone = fetchError || criticalAttention || blockedFlow ? "critical" : openAttention > 0 || staleStage ? "warning" : "healthy";

  const verdict =
    state === null
      ? "Loading live system state"
      : verdictTone === "critical"
        ? `Needs review - ${openAttention} open item${openAttention === 1 ? "" : "s"}`
        : openAttention > 0
          ? `Healthy - with ${openAttention} item${openAttention === 1 ? "" : "s"} to review`
          : "Healthy - no open review items";

  const verdictDetail =
    state === null
      ? "The console is waiting for the first /api/ops/system-state response."
      : fetchError
        ? `Latest poll failed: ${fetchError}. Showing the last successful response.`
        : staleStage
          ? `${healthyStages} of ${totalStages} primary stages are running. ${staleStage.title} is ${staleStage.status}.`
          : `${healthyStages} of ${totalStages} primary stages are running. Live execution remains blocked in code.`;

  const dataFreshnessValue = staleStage ? formatAgeFromNow(staleStage.lastSuccessAt, generatedAt) : state ? "fresh" : "--";
  const dataFreshnessSub = staleStage ? `${staleStage.title.toLowerCase()} ${staleStage.status}` : "tracked stages current";

  return (
    <section className="px-5 py-8 sm:px-10">
      <p className="mb-1 text-[11px] uppercase tracking-[.16em] text-[var(--color-text-dim)]">
        01 &middot; Overview
      </p>
      <h2 className="text-[24px] font-semibold tracking-normal text-[var(--color-text-primary)]">
        System status at a glance
      </h2>

      <div className="mt-6 flex flex-col gap-5 rounded-[14px] border border-[var(--color-border-default)] bg-[var(--color-surface-card)] px-6 py-6 sm:flex-row sm:items-center">
        <span className={`h-[13px] w-[13px] shrink-0 rounded-full ${verdictToneClass[verdictTone]}`} />
        <div className="min-w-0 flex-1">
          <p className="text-[23px] font-semibold leading-tight text-[var(--color-text-primary)]">{verdict}</p>
          <p className="mt-2 text-[14px] leading-[1.5] text-[var(--color-text-secondary)]">{verdictDetail}</p>
        </div>
        <button
          type="button"
          onClick={onReviewItems}
          className="inline-flex min-h-10 items-center justify-center rounded-[9px] border border-[var(--color-border-default)] bg-[var(--color-surface-hover)] px-4 text-[12px] font-semibold text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-blue)]/60"
        >
          Review items &rarr;
        </button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Pipeline" value={pipelineValue} sub="primary stages running" tone="green" />
        <KpiCard label="Data freshness" value={dataFreshnessValue} sub={dataFreshnessSub} tone={staleStage ? "amber" : "green"} />
        <KpiCard label="Paper net P&L" value={formatCurrency(netPnl)} sub="simulated" tone={netPnl >= 0 ? "green" : "red"} />
        <KpiCard label="Execution" value="Off" sub="safe - blocked in code" tone="red" />
      </div>

      <p className="mb-3 mt-7 text-[11px] uppercase tracking-[.14em] text-[var(--color-text-dim)]">
        Delivery phases
      </p>
      <div className="flex flex-wrap gap-2">
        {PHASES.map((phase) => (
          <span
            key={phase.label}
            title={phase.note}
            className={`rounded-full border px-3 py-1.5 text-[11px] font-medium capitalize tracking-normal ${phaseTone[phase.status]}`}
          >
            {phase.label} &middot; {phase.status}
          </span>
        ))}
      </div>

      <p className="mt-7 max-w-[740px] text-[14px] leading-[1.7] text-[var(--color-text-secondary)]">
        {PLATFORM_DESCRIPTION}
      </p>
    </section>
  );
}

function KpiCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "green" | "amber" | "red";
}) {
  const toneClass = {
    green: "text-[var(--color-accent-green)]",
    amber: "text-[var(--color-accent-amber)]",
    red: "text-[var(--color-accent-red)]",
  };

  return (
    <div className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-surface-card)] px-5 py-[18px]">
      <p className="mb-2 text-[11px] uppercase tracking-[.1em] text-[var(--color-text-muted)]">{label}</p>
      <p className={`text-[28px] font-light leading-none tabular-nums ${toneClass[tone]}`}>{value}</p>
      <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">{sub}</p>
    </div>
  );
}
