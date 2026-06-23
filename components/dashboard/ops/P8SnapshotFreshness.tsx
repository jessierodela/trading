import type { P8OpsSummary } from "@/lib/ops/p8Types";
import { formatTimestamp, OpsPanel, OpsStatusPill, shortId } from "./P8OpsUI";

export function P8SnapshotFreshness({ data }: { data: P8OpsSummary }) {
  const snapshot = data.snapshot.latestDashboardSnapshot;
  const status = !snapshot ? "missing" : snapshot.isExpired ? "stale" : "healthy";
  return (
    <OpsPanel title="Dashboard Snapshot" eyebrow="Persisted consumer state" action={<OpsStatusPill status={status} />}>
      <div className="grid grid-cols-2 border-b border-[var(--color-border-subtle)]">
        <div className="border-r border-[var(--color-border-subtle)] px-4 py-3">
          <p className="text-[9px] uppercase text-[var(--color-text-dim)]">Generated</p>
          <p className="mt-1 text-[10px] text-[var(--color-text-primary)]">{formatTimestamp(snapshot?.generatedAt ?? null)}</p>
        </div>
        <div className="px-4 py-3">
          <p className="text-[9px] uppercase text-[var(--color-text-dim)]">Expires</p>
          <p className="mt-1 text-[10px] text-[var(--color-text-primary)]">{formatTimestamp(snapshot?.expiresAt ?? null)}</p>
        </div>
      </div>
      <dl className="divide-y divide-[var(--color-border-subtle)] px-4 text-[10px]">
        <div className="grid grid-cols-[126px_1fr] gap-3 py-3">
          <dt className="text-[var(--color-text-dim)]">Source job</dt>
          <dd className="font-mono text-[var(--color-text-primary)]" title={snapshot?.sourceJobPublicId ?? undefined}>{shortId(snapshot?.sourceJobPublicId ?? null)}</dd>
        </div>
        <div className="grid grid-cols-[126px_1fr] gap-3 py-3">
          <dt className="text-[var(--color-text-dim)]">/api/signals source</dt>
          <dd><OpsStatusPill status={data.snapshot.signalsSource === "dashboard_snapshots" ? "healthy" : data.snapshot.signalsSource === "memCache" ? "stale" : "missing"} label={data.snapshot.signalsSource} /></dd>
        </div>
        <div className="grid grid-cols-[126px_1fr] gap-3 py-3">
          <dt className="text-[var(--color-text-dim)]">Payload</dt>
          <dd className="text-[var(--color-text-secondary)]">
            {snapshot ? `${snapshot.payloadSummary.agentResultsCount} agents, ${snapshot.payloadSummary.activityCount} events, ${snapshot.payloadSummary.confluenceCount} confluence` : "No payload"}
          </dd>
        </div>
        <div className="grid grid-cols-[126px_1fr] gap-3 py-3">
          <dt className="text-[var(--color-text-dim)]">Symbols</dt>
          <dd className="break-words font-mono text-[9px] text-[var(--color-text-secondary)]">{snapshot?.payloadSummary.symbols.join(", ") || "None"}</dd>
        </div>
      </dl>
    </OpsPanel>
  );
}
