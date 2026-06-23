import type { P8OpsSummary } from "@/lib/ops/p8Types";
import { OpsStatusPill } from "./P8OpsUI";

type FlowStatus = "healthy" | "active" | "queued" | "running" | "stale" | "blocked" | "missing" | "unknown";

function pipelineStatus(data: P8OpsSummary): FlowStatus {
  const statuses = data.pipeline.stages.map((stage) => stage.status);
  if (statuses.some((status) => status === "failed" || status === "dead")) return "blocked";
  if (statuses.includes("running")) return "running";
  if (statuses.includes("queued")) return "queued";
  if (statuses.every((status) => status === "missing")) return "missing";
  return "healthy";
}

function queueStatus(data: P8OpsSummary): FlowStatus {
  if (data.queue.counts.running > 0) return "running";
  if (data.queue.counts.queued > 0) return "queued";
  if (data.queue.counts.dead > 0 || data.queue.counts.failed > 0) return "blocked";
  if (data.queue.recentJobs.length > 0) return "healthy";
  return "unknown";
}

function workerStatus(data: P8OpsSummary): FlowStatus {
  if (data.worker.status === "active") return "active";
  if (data.worker.status === "attention") return "blocked";
  if (data.worker.status === "recently_active" || data.worker.status === "idle") return "healthy";
  return "unknown";
}

export function P8SystemFlow({ data }: { data: P8OpsSummary }) {
  const snapshot = data.snapshot.latestDashboardSnapshot;
  const regimes = data.regime.symbols;
  const storesStatus: FlowStatus = regimes.some((row) => row.source === "empty")
    ? "missing"
    : regimes.some((row) => row.stale)
      ? "stale"
      : "healthy";
  const snapshotStatus: FlowStatus = !snapshot ? "missing" : snapshot.isExpired ? "stale" : "healthy";
  const consumerStatus: FlowStatus = data.snapshot.signalsSource === "dashboard_snapshots"
    ? "healthy"
    : data.snapshot.signalsSource === "memCache"
      ? "stale"
      : "missing";
  const nodes: Array<{ label: string; detail: string; status: FlowStatus }> = [
    {
      label: "Cron scheduler",
      detail: data.scheduler.lastScheduledFeed ? "Feed observed" : "Awaiting feed evidence",
      status: data.scheduler.lastScheduledFeed ? "active" : "unknown",
    },
    { label: "Durable jobs", detail: `${data.queue.counts.queued} queued`, status: queueStatus(data) },
    { label: "Worker", detail: data.worker.status.replaceAll("_", " "), status: workerStatus(data) },
    { label: "Pipeline", detail: "Six ordered stages", status: pipelineStatus(data) },
    { label: "Persisted stores", detail: "Bars, features, regimes, signals", status: storesStatus },
    { label: "Dashboard snapshots", detail: snapshot ? "Latest snapshot available" : "No snapshot", status: snapshotStatus },
    { label: "UI and Telegram", detail: `Signals: ${data.snapshot.signalsSource}`, status: consumerStatus },
  ];

  return (
    <section className="border-b border-[var(--color-border-default)] px-4 py-5 sm:px-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[9px] uppercase text-[var(--color-text-dim)]">Priority 8 architecture</p>
          <h2 className="mt-1 text-[14px] font-medium text-[var(--color-text-primary)]">System Flow</h2>
        </div>
        <p className="max-w-xl text-[10px] leading-5 text-[var(--color-text-muted)]">
          Scheduler to durable state to consumer reads. Every status is inferred from persisted evidence.
        </p>
      </div>
      <div className="overflow-x-auto pb-2">
        <div className="flex min-w-max items-stretch">
          {nodes.map((node, index) => (
            <div key={node.label} className="flex items-center">
              <div className="flex h-[104px] w-[172px] flex-col justify-between rounded-md border border-[var(--color-border-default)] bg-[var(--color-surface-card)] p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-[9px] text-[var(--color-text-dim)]">{String(index + 1).padStart(2, "0")}</span>
                  <OpsStatusPill status={node.status} />
                </div>
                <div>
                  <p className="text-[11px] font-medium text-[var(--color-text-primary)]">{node.label}</p>
                  <p className="mt-1 max-w-[148px] text-[9px] leading-4 text-[var(--color-text-muted)]">{node.detail}</p>
                </div>
              </div>
              {index < nodes.length - 1 ? (
                <span aria-hidden="true" className="w-7 text-center text-[12px] text-[var(--color-text-dim)]">&rarr;</span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
