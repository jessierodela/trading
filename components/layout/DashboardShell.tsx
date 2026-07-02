"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { OverviewSection } from "@/components/dashboard/OverviewSection";
import { AttentionPanel } from "@/components/dashboard/ops/AttentionPanel";
import { OpsStatusPill, formatTimestamp } from "@/components/dashboard/ops/P8OpsUI";
import { SystemFlowMap } from "@/components/dashboard/ops/SystemFlowMap";
import { SIGNALS_POLL_MS } from "@/config/polling";
import type { SystemStateResponse } from "@/lib/ops/systemState";
import { SectionNav, type DashboardSection } from "./SectionNav";

const SYSTEM_STATE_POLL_MS = 20_000;

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

interface DashboardShellProps {
  paperSummary: PaperSummarySnapshot;
  paperPanel: ReactNode;
  glossaryPanel: ReactNode;
}

export function DashboardShell({ paperSummary, paperPanel, glossaryPanel }: DashboardShellProps) {
  const [activeSection, setActiveSection] = useState<DashboardSection>("overview");
  const { state, fetchError, lastPolledAt } = useSystemState();

  useSignalsPoll();

  const attentionCount = state?.attention.filter((item) => item.severity !== "info").length ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <SectionNav
        activeSection={activeSection}
        attentionCount={attentionCount}
        onSectionChange={setActiveSection}
      />

      <main className="min-w-0 flex-1 overflow-y-auto bg-[var(--color-surface-base)]">
        <div className="mx-auto max-w-[1080px]">
          <SystemStateBanner state={state} fetchError={fetchError} lastPolledAt={lastPolledAt} />

          {activeSection === "overview" ? (
            <OverviewSection
              state={state}
              fetchError={fetchError}
              paperSummary={paperSummary}
              onReviewItems={() => setActiveSection("attention")}
            />
          ) : null}

          {activeSection === "pipeline" ? (
            state ? <SystemFlowMap flow={state.flow} execution={state.execution} /> : <SectionLoading title="Pipeline" fetchError={fetchError} />
          ) : null}

          {activeSection === "attention" ? (
            state ? <AttentionPanel items={state.attention} /> : <SectionLoading title="Attention" fetchError={fetchError} />
          ) : null}

          {activeSection === "paper" ? paperPanel : null}
          {activeSection === "glossary" ? glossaryPanel : null}
        </div>
      </main>
    </div>
  );
}

function useSystemState() {
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
      } catch (error) {
        if (!disposed && !controller.signal.aborted) {
          setFetchError(error instanceof Error ? error.message : "system state unavailable");
        }
      } finally {
        inFlight = false;
      }
    }

    void poll();
    const timer = window.setInterval(() => void poll(), SYSTEM_STATE_POLL_MS);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  return { state, fetchError, lastPolledAt };
}

function useSignalsPoll() {
  const fetchSignals = useCallback(async () => {
    try {
      await fetch("/api/signals", { cache: "no-store" });
    } catch {
      // This preserves the existing dashboard heartbeat without changing visible state.
    }
  }, []);

  useEffect(() => {
    void fetchSignals();
    const timer = window.setInterval(() => void fetchSignals(), SIGNALS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [fetchSignals]);
}

function SystemStateBanner({
  state,
  fetchError,
  lastPolledAt,
}: {
  state: SystemStateResponse | null;
  fetchError: string | null;
  lastPolledAt: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] px-5 py-3 sm:px-10">
      <div className="flex flex-wrap items-center gap-2">
        <OpsStatusPill status={fetchError ? "stale" : state ? "healthy" : "active"} label={fetchError ? "poll delayed" : state ? "polling 20s" : "loading"} />
        {state && !state.ops.available ? <OpsStatusPill status="blocked" label="ops data unavailable" /> : null}
        {state && !state.riskGate.available ? <OpsStatusPill status="warning" label="risk gate unavailable" /> : null}
      </div>
      <div className="text-left sm:text-right">
        <p className="text-[10px] uppercase tracking-[.14em] text-[var(--color-text-dim)]">Last polled</p>
        <p className="mt-1 font-mono text-[11px] text-[var(--color-text-secondary)]">{formatTimestamp(lastPolledAt)}</p>
      </div>
      {fetchError ? (
        <p role="status" className="basis-full rounded-md border border-[var(--color-accent-amber)]/30 bg-[var(--color-accent-amber)]/5 px-3 py-2 text-[11px] text-[var(--color-accent-amber)]">
          Latest system-state poll failed: {fetchError}. The console keeps the last successful response visible.
        </p>
      ) : null}
    </div>
  );
}

function SectionLoading({ title, fetchError }: { title: string; fetchError: string | null }) {
  return (
    <section className="px-5 py-8 sm:px-10" aria-busy="true">
      <p className="mb-1 text-[11px] uppercase tracking-[.16em] text-[var(--color-text-dim)]">{title}</p>
      <h2 className="text-[24px] font-semibold text-[var(--color-text-primary)]">Waiting for live system state</h2>
      {fetchError ? (
        <p role="alert" className="mt-4 rounded-md border border-[var(--color-accent-red)]/30 bg-[var(--color-accent-red)]/5 px-4 py-3 text-[13px] text-[var(--color-accent-red)]">
          The system-state endpoint could not be reached: {fetchError}.
        </p>
      ) : (
        <div className="mt-6 grid gap-3 md:grid-cols-3">
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-32 animate-pulse rounded-xl border border-[var(--color-border-default)] bg-[var(--color-surface-card)]" />
          ))}
        </div>
      )}
    </section>
  );
}
