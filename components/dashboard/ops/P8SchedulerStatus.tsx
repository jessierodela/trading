import type { P8OpsSummary } from "@/lib/ops/p8Types";
import { formatTimestamp, OpsPanel, OpsStatusPill } from "./P8OpsUI";

export function P8SchedulerStatus({ data }: { data: P8OpsSummary }) {
  const scheduler = data.scheduler;
  const status = scheduler.lastScheduledFeed ? "active" : "unknown";
  return (
    <OpsPanel title="External Scheduler" eyebrow="Linux/systemd trigger" action={<OpsStatusPill status={status} />}>
      <dl className="divide-y divide-[var(--color-border-subtle)] px-4 text-[10px]">
        <div className="grid grid-cols-[126px_1fr] gap-3 py-3">
          <dt className="text-[var(--color-text-dim)]">Route</dt>
          <dd className="font-mono text-[var(--color-text-primary)]">{scheduler.routePath}</dd>
        </div>
        <div className="grid grid-cols-[126px_1fr] gap-3 py-3">
          <dt className="text-[var(--color-text-dim)]">Schedule</dt>
          <dd><span className="font-mono text-[var(--color-text-primary)]">{scheduler.cronExpression}</span><span className="ml-2 text-[var(--color-text-muted)]">{scheduler.cronMeaning}</span></dd>
        </div>
        <div className="grid grid-cols-[126px_1fr] gap-3 py-3">
          <dt className="text-[var(--color-text-dim)]">Closed bar</dt>
          <dd className="text-[var(--color-text-secondary)]">{formatTimestamp(scheduler.lastScheduledFeed?.closedBarTs ?? null)}</dd>
        </div>
        <div className="grid grid-cols-[126px_1fr] gap-3 py-3">
          <dt className="text-[var(--color-text-dim)]">Last enqueue</dt>
          <dd className="text-[var(--color-text-secondary)]">{formatTimestamp(scheduler.lastScheduledFeed?.enqueuedAt ?? null)}</dd>
        </div>
        <div className="grid grid-cols-[126px_1fr] gap-3 py-3">
          <dt className="text-[var(--color-text-dim)]">Secret present</dt>
          <dd><OpsStatusPill status={scheduler.schedulerSecretPresent ? "pass" : "partial"} label={scheduler.schedulerSecretPresent ? "yes" : "no"} /></dd>
        </div>
        <div className="grid grid-cols-[126px_1fr] gap-3 py-3">
          <dt className="text-[var(--color-text-dim)]">External verified</dt>
          <dd><OpsStatusPill status={scheduler.externalSchedulerVerified} /></dd>
        </div>
      </dl>
    </OpsPanel>
  );
}
