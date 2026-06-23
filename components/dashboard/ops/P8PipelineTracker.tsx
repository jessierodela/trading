import type { P8OpsSummary } from "@/lib/ops/p8Types";
import { formatDuration, formatTimestamp, OpsPanel, OpsStatusPill, shortId } from "./P8OpsUI";

export function P8PipelineTracker({ data }: { data: P8OpsSummary }) {
  return (
    <OpsPanel title="Pipeline Stage Tracker" eyebrow="Ordered scheduled feed" className="xl:col-span-2">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] table-fixed text-left">
          <thead className="border-b border-[var(--color-border-subtle)] text-[9px] uppercase text-[var(--color-text-dim)]">
            <tr>
              <th className="w-[230px] px-4 py-2 font-normal">Stage</th>
              <th className="w-[100px] px-3 py-2 font-normal">Status</th>
              <th className="w-[120px] px-3 py-2 font-normal">Job ID</th>
              <th className="w-[90px] px-3 py-2 font-normal">Attempts</th>
              <th className="w-[165px] px-3 py-2 font-normal">Timing</th>
              <th className="px-3 py-2 font-normal">Result / Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-subtle)]">
            {data.pipeline.stages.map((stage, index) => (
              <tr key={stage.stage} className="h-[66px]">
                <td className="px-4 py-2">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[9px] text-[var(--color-text-dim)]">{String(index + 1).padStart(2, "0")}</span>
                    <span className="font-mono text-[10px] text-[var(--color-text-primary)]">{stage.stage}</span>
                  </div>
                </td>
                <td className="px-3 py-2"><OpsStatusPill status={stage.status} /></td>
                <td className="px-3 py-2 font-mono text-[9px] text-[var(--color-text-secondary)]" title={stage.publicId ?? undefined}>{shortId(stage.publicId)}</td>
                <td className="px-3 py-2 font-mono text-[10px] text-[var(--color-text-secondary)]">{stage.attempts} / {stage.maxAttempts || "-"}</td>
                <td className="px-3 py-2">
                  <p className="text-[9px] text-[var(--color-text-secondary)]">{formatDuration(stage.durationMs)}</p>
                  <p className="mt-1 text-[8px] text-[var(--color-text-dim)]">{formatTimestamp(stage.completedAt ?? stage.failedAt ?? stage.startedAt)}</p>
                </td>
                <td className="px-3 py-2">
                  <p className={`line-clamp-2 text-[9px] leading-4 ${stage.error ? "text-[var(--color-accent-red)]" : "text-[var(--color-text-muted)]"}`} title={stage.error ?? stage.resultSummary ?? undefined}>
                    {stage.error ?? stage.resultSummary ?? "No result recorded"}
                  </p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </OpsPanel>
  );
}
