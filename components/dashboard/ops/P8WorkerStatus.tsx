import type { P8OpsSummary } from "@/lib/ops/p8Types";
import { formatTimestamp, OpsPanel, OpsStatusPill, shortId } from "./P8OpsUI";

export function P8WorkerStatus({ data }: { data: P8OpsSummary }) {
  const worker = data.worker;
  return (
    <OpsPanel title="Worker" eyebrow="Inferred from persisted leases" action={<OpsStatusPill status={worker.status} />}>
      <dl className="divide-y divide-[var(--color-border-subtle)] px-4 text-[10px]">
        <div className="grid grid-cols-[128px_1fr] gap-3 py-3">
          <dt className="text-[var(--color-text-dim)]">Last claimed job</dt>
          <dd className="truncate font-mono text-[var(--color-text-primary)]" title={worker.lastClaimedJob?.publicId}>{shortId(worker.lastClaimedJob?.publicId ?? null)}</dd>
        </div>
        <div className="grid grid-cols-[128px_1fr] gap-3 py-3">
          <dt className="text-[var(--color-text-dim)]">Last completed job</dt>
          <dd className="truncate font-mono text-[var(--color-text-primary)]" title={worker.lastCompletedJob?.publicId}>{shortId(worker.lastCompletedJob?.publicId ?? null)}</dd>
        </div>
        <div className="grid grid-cols-[128px_1fr] gap-3 py-3">
          <dt className="text-[var(--color-text-dim)]">Heartbeat / lease</dt>
          <dd className="text-[var(--color-text-secondary)]">{formatTimestamp(worker.lastHeartbeatOrLeaseAt)}</dd>
        </div>
      </dl>
      <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-panel)] px-4 py-3">
        <p className="text-[9px] uppercase text-[var(--color-text-dim)]">Recommended host command</p>
        <code className="mt-2 block overflow-x-auto whitespace-nowrap font-mono text-[9px] text-[var(--color-text-secondary)]">{worker.recommendation}</code>
      </div>
    </OpsPanel>
  );
}
