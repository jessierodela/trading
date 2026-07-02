"use client";

/**
 * components/dashboard/ops/SystemStateConsole.tsx
 *
 * Single polling container for the operations dashboard. Fetches
 * /api/ops/system-state once every POLL_MS and passes the composed state to
 * every live section — one request feeds the flow map, operations grid,
 * pipeline tracker, truthfulness panel, risk gate panel, and attention list.
 *
 * The route always returns 200; unavailability is reported inside the payload
 * and rendered honestly instead of hidden behind an error page.
 */

import { useEffect, useState } from "react";
import type { SystemStateResponse } from "@/lib/ops/systemState";
import { P8PipelineTracker } from "./P8PipelineTracker";
import { P8ProductionChecklist } from "./P8ProductionChecklist";
import { P8QueueHealth } from "./P8QueueHealth";
import { P8RegimeFreshness } from "./P8RegimeFreshness";
import { P8SchedulerStatus } from "./P8SchedulerStatus";
import { P8SnapshotFreshness } from "./P8SnapshotFreshness";
import { P8WorkerStatus } from "./P8WorkerStatus";
import { SystemFlowMap } from "./SystemFlowMap";
import { AttentionPanel } from "./AttentionPanel";
import { DataTruthfulnessPanel } from "./DataTruthfulnessPanel";
import { RiskExecutionSafetyPanel } from "./RiskExecutionSafetyPanel";
import { formatTimestamp, OpsStatusPill } from "./P8OpsUI";

const POLL_MS = 20_000;

function SectionHeading({ eyebrow, title, hint }: { eyebrow: string; title: string; hint?: string }) {
  return (
    <div className="px-4 pt-5 sm:px-6">
      <p className="text-[9px] uppercase tracking-[.18em] text-[var(--color-text-dim)]">{eyebrow}</p>
      <h2 className="mt-1 text-[14px] font-medium text-[var(--color-text-primary)]">{title}</h2>
      {hint ? <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">{hint}</p> : null}
    </div>
  );
}

export function SystemStateConsole() {
  const [state, setState] = useState<SystemStateResponse | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let inFlight = false;

    async function poll() {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch("/api/ops/system-state", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`system-state API returned ${response.status}`);
        const body = (await response.json()) as SystemStateResponse;
        if (!disposed) {
          setState(body);
          setFetchError(null);
          setLastPolledAt(new Date().toISOString());
        }
      } catch (pollError) {
        if (!disposed && !controller.signal.aborted) {
          setFetchError(pollError instanceof Error ? pollError.message : "system state unavailable");
        }
      } finally {
        inFlight = false;
      }
    }

    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  if (state === null) {
    return (
      <section className="border-b border-[var(--color-border-default)] px-4 py-6 sm:px-6" aria-busy="true">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[14px] font-medium text-[var(--color-text-primary)]">System State</h2>
          <OpsStatusPill status={fetchError ? "blocked" : "active"} label={fetchError ? "unreachable" : "loading"} />
        </div>
        {fetchError ? (
          <p role="alert" className="mt-3 rounded-md border border-[var(--color-accent-red)]/30 bg-[var(--color-accent-red)]/5 px-4 py-3 text-[10px] text-[var(--color-accent-red)]">
            The system-state endpoint could not be reached: {fetchError}. Nothing below can be
            shown until it responds — this dashboard does not fall back to fake data.
          </p>
        ) : (
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-28 animate-pulse rounded-md border border-[var(--color-border-default)] bg-[var(--color-surface-card)]" />
            ))}
          </div>
        )}
      </section>
    );
  }

  const ops = state.ops.summary;

  return (
    <div className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-panel)]">
      {/* Console header */}
      <section className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border-default)] px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[15px] font-medium text-[var(--color-text-primary)]">System State</h2>
          <OpsStatusPill status={fetchError ? "stale" : "healthy"} label={fetchError ? "poll delayed" : "polling 20s"} />
          {!state.ops.available ? <OpsStatusPill status="blocked" label="ops data unavailable" /> : null}
          {!state.riskGate.available ? <OpsStatusPill status="warning" label="risk gate unavailable" /> : null}
        </div>
        <div className="text-right">
          <p className="text-[9px] uppercase text-[var(--color-text-dim)]">Last polled</p>
          <p className="mt-1 font-mono text-[9px] text-[var(--color-text-secondary)]">{formatTimestamp(lastPolledAt)}</p>
        </div>
      </section>

      {fetchError ? (
        <p role="status" className="border-b border-[var(--color-accent-amber)]/20 bg-[var(--color-accent-amber)]/5 px-4 py-2 text-[9px] text-[var(--color-accent-amber)] sm:px-6">
          Latest poll failed: {fetchError}. Showing the last successful response from {formatTimestamp(lastPolledAt)}.
        </p>
      ) : null}

      {/* 2 — System flow map */}
      <SystemFlowMap flow={state.flow} />

      {/* 3 — Current operations state */}
      <SectionHeading
        eyebrow="Section 3"
        title="Current Operations State"
        hint="Scheduler, worker, queue, and snapshot state read live from the database."
      />
      {ops === null ? (
        <p className="px-4 py-4 text-[10px] text-[var(--color-accent-amber)] sm:px-6">
          Operations data is unavailable ({state.ops.reason ?? "unknown reason"}), so scheduler,
          worker, queue, and freshness state cannot be shown. See What Needs Attention below.
        </p>
      ) : (
        <div className="grid gap-4 px-4 py-4 sm:px-6 xl:grid-cols-2">
          <P8SchedulerStatus data={ops} />
          <P8WorkerStatus data={ops} />
          <P8SnapshotFreshness data={ops} />
          <P8ProductionChecklist data={ops} />
        </div>
      )}

      {/* 4 — Jobs & pipeline tracker */}
      <SectionHeading
        eyebrow="Section 4"
        title="Jobs & Pipeline Tracker"
        hint={`What the worker is actually doing. Next scheduled feed expected at ${formatTimestamp(state.scheduler.nextExpectedFeedAt)} (cron ${state.scheduler.cronExpression}).`}
      />
      {ops === null ? (
        <p className="px-4 py-4 text-[10px] text-[var(--color-accent-amber)] sm:px-6">
          Job and pipeline state is unavailable ({state.ops.reason ?? "unknown reason"}).
        </p>
      ) : (
        <div className="grid gap-4 px-4 py-4 sm:px-6 xl:grid-cols-2">
          <P8PipelineTracker data={ops} />
          <P8QueueHealth data={ops} />
        </div>
      )}

      {/* 5 — Data truthfulness */}
      <SectionHeading
        eyebrow="Section 5"
        title="Data Truthfulness"
        hint="Every part of this dashboard, classified: real, static, stale, missing, or disabled."
      />
      <div className="px-4 py-4 sm:px-6">
        <DataTruthfulnessPanel entries={state.truthfulness} />
      </div>

      {/* 6 — Research / strategy layer (live part) */}
      <SectionHeading
        eyebrow="Section 6"
        title="Research / Strategy Layer — Live State"
        hint="Latest persisted regime per symbol. Strategy evaluation runs appear in the pipeline tracker above. Static research notes are grouped further down and labeled as such."
      />
      {ops === null ? (
        <p className="px-4 py-4 text-[10px] text-[var(--color-accent-amber)] sm:px-6">
          Regime state is unavailable ({state.ops.reason ?? "unknown reason"}).
        </p>
      ) : (
        <div className="px-4 py-4 sm:px-6">
          <P8RegimeFreshness data={ops} />
        </div>
      )}

      {/* 7 — Risk / execution safety */}
      <SectionHeading
        eyebrow="Section 7"
        title="Risk / Execution Safety"
        hint="Live risk gate decisions plus the code-level execution block."
      />
      <div className="px-4 py-4 sm:px-6">
        <RiskExecutionSafetyPanel state={state} />
      </div>

      {/* 8 — What needs attention */}
      <SectionHeading
        eyebrow="Section 8"
        title="What Needs Attention"
        hint="Prioritized issues generated from the automated checks in this poll."
      />
      <div className="px-4 py-4 pb-6 sm:px-6">
        <AttentionPanel items={state.attention} />
      </div>
    </div>
  );
}
