"use client";

import { useEffect, useState } from "react";
import type { P8OpsSummary } from "@/lib/ops/p8Types";
import { P8PipelineTracker } from "./P8PipelineTracker";
import { P8ProductionChecklist } from "./P8ProductionChecklist";
import { P8QueueHealth } from "./P8QueueHealth";
import { P8RegimeFreshness } from "./P8RegimeFreshness";
import { P8SchedulerStatus } from "./P8SchedulerStatus";
import { P8SnapshotFreshness } from "./P8SnapshotFreshness";
import { P8SystemFlow } from "./P8SystemFlow";
import { P8WorkerStatus } from "./P8WorkerStatus";
import { formatTimestamp, OpsStatusPill } from "./P8OpsUI";

const POLL_MS = 20_000;

export function P8OperationsConsole() {
  const [data, setData] = useState<P8OpsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let inFlight = false;

    async function poll() {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch("/api/ops/p8", {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json() as P8OpsSummary | { error?: string };
        if (!response.ok) {
          throw new Error("error" in body && body.error ? body.error : `Operations API returned ${response.status}`);
        }
        if (!disposed) {
          setData(body as P8OpsSummary);
          setError(null);
          setLastUpdated(new Date().toISOString());
        }
      } catch (pollError) {
        if (!disposed && !controller.signal.aborted) {
          setError(pollError instanceof Error ? pollError.message : "Operations data is unavailable");
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

  if (!data) {
    return (
      <section className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-panel)] px-4 py-6 sm:px-6" aria-busy="true">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <p className="text-[9px] uppercase text-[var(--color-text-dim)]">Priority 8</p>
            <h2 className="mt-1 text-[15px] font-medium text-[var(--color-text-primary)]">Operations Console</h2>
          </div>
          <OpsStatusPill status={error ? "blocked" : "active"} label={error ? "unavailable" : "loading"} />
        </div>
        {error ? (
          <p role="alert" className="rounded-md border border-[var(--color-accent-red)]/30 bg-[var(--color-accent-red)]/5 px-4 py-3 text-[10px] text-[var(--color-accent-red)]">{error}</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            {[0, 1, 2].map((item) => <div key={item} className="h-28 animate-pulse rounded-md border border-[var(--color-border-default)] bg-[var(--color-surface-card)]" />)}
          </div>
        )}
      </section>
    );
  }

  return (
    <div className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-panel)]">
      <section className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border-default)] px-4 py-4 sm:px-6">
        <div>
          <p className="text-[9px] uppercase text-[var(--color-text-dim)]">Priority 8 observability</p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h2 className="text-[15px] font-medium text-[var(--color-text-primary)]">Operations Console</h2>
            <OpsStatusPill status={error ? "stale" : "healthy"} label={error ? "poll delayed" : "polling 20s"} />
          </div>
        </div>
        <div className="text-right">
          <p className="text-[9px] uppercase text-[var(--color-text-dim)]">Last updated</p>
          <p className="mt-1 font-mono text-[9px] text-[var(--color-text-secondary)]">{formatTimestamp(lastUpdated)}</p>
        </div>
      </section>

      {error ? (
        <p role="status" className="border-b border-[var(--color-accent-amber)]/20 bg-[var(--color-accent-amber)]/5 px-4 py-2 text-[9px] text-[var(--color-accent-amber)] sm:px-6">
          Latest poll failed: {error}. Showing the last successful response.
        </p>
      ) : null}

      <P8SystemFlow data={data} />

      <div className="grid gap-4 px-4 py-5 sm:px-6 xl:grid-cols-2">
        <P8PipelineTracker data={data} />
        <P8SchedulerStatus data={data} />
        <P8WorkerStatus data={data} />
        <P8SnapshotFreshness data={data} />
        <P8ProductionChecklist data={data} />
        <P8QueueHealth data={data} />
        <P8RegimeFreshness data={data} />
      </div>
    </div>
  );
}
