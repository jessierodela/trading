import type { P8OpsSummary } from "@/lib/ops/p8Types";
import { formatAge, formatTimestamp, OpsMetric, OpsPanel, OpsStatusPill, shortId } from "./P8OpsUI";

export function P8QueueHealth({ data }: { data: P8OpsSummary }) {
  const { counts } = data.queue;
  return (
    <OpsPanel title="Queue Health" eyebrow={`Succeeded and failed use a ${data.queue.recentWindowHours}h window`} className="xl:col-span-2">
      <div className="grid grid-cols-2 border-b border-[var(--color-border-subtle)] sm:grid-cols-4 lg:grid-cols-8">
        <OpsMetric label="Queued" value={counts.queued} />
        <OpsMetric label="Running" value={counts.running} />
        <OpsMetric label="Succeeded" value={counts.succeeded} />
        <OpsMetric label="Failed" value={counts.failed} />
        <OpsMetric label="Dead" value={counts.dead} />
        <OpsMetric label="Oldest queued" value={formatAge(data.queue.oldestQueuedAgeSeconds)} />
        <OpsMetric label="Expired leases" value={data.queue.expiredLeaseCount} />
        <OpsMetric label="Latest event" value={formatTimestamp(data.queue.latestJobEventAt)} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1120px] table-fixed text-left">
          <thead className="border-b border-[var(--color-border-subtle)] text-[9px] uppercase text-[var(--color-text-dim)]">
            <tr>
              <th className="w-[190px] px-4 py-2 font-normal">Job type</th>
              <th className="w-[95px] px-3 py-2 font-normal">Status</th>
              <th className="w-[70px] px-3 py-2 font-normal">Priority</th>
              <th className="w-[90px] px-3 py-2 font-normal">Attempts</th>
              <th className="w-[140px] px-3 py-2 font-normal">Run after</th>
              <th className="w-[140px] px-3 py-2 font-normal">Created</th>
              <th className="w-[140px] px-3 py-2 font-normal">Started</th>
              <th className="w-[140px] px-3 py-2 font-normal">Completed / failed</th>
              <th className="w-[120px] px-3 py-2 font-normal">Public ID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-subtle)]">
            {data.queue.recentJobs.slice(0, 10).map((job) => (
              <tr key={job.publicId} className="h-[48px] text-[9px] text-[var(--color-text-secondary)]">
                <td className="px-4 py-2 font-mono text-[var(--color-text-primary)]">{job.jobType}</td>
                <td className="px-3 py-2"><OpsStatusPill status={job.status} /></td>
                <td className="px-3 py-2 font-mono">{job.priority}</td>
                <td className="px-3 py-2 font-mono">{job.attempts} / {job.maxAttempts}</td>
                <td className="px-3 py-2">{formatTimestamp(job.runAfter)}</td>
                <td className="px-3 py-2">{formatTimestamp(job.createdAt)}</td>
                <td className="px-3 py-2">{formatTimestamp(job.startedAt)}</td>
                <td className="px-3 py-2">{formatTimestamp(job.completedAt ?? job.failedAt)}</td>
                <td className="px-3 py-2 font-mono" title={job.publicId}>{shortId(job.publicId)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.queue.recentJobs.length === 0 ? (
          <div className="px-4 py-8 text-center text-[10px] text-[var(--color-text-muted)]">No persisted jobs are visible yet.</div>
        ) : null}
      </div>
    </OpsPanel>
  );
}
