// components/dashboard/ops/RiskExecutionSafetyPanel.tsx
// Live risk gate state from /api/ops/risk-gate plus the code-enforced
// execution block. Live execution status is provable from the repo:
// FORBIDDEN_LIVE_JOB_TYPES is rejected at the job store layer.

import type { SystemStateResponse } from "@/lib/ops/systemState";
import { formatTimestamp, OpsMetric, OpsPanel, OpsStatusPill } from "./P8OpsUI";

export function RiskExecutionSafetyPanel({ state }: { state: SystemStateResponse }) {
  const riskGate = state.riskGate.summary;

  return (
    <OpsPanel
      eyebrow="Risk / execution safety"
      title="Risk Gate & Execution Status"
      action={<OpsStatusPill status="blocked" label="live execution disabled" />}
    >
      {/* Execution block — provable from code, not a claim */}
      <div className="border-b border-[var(--color-border-subtle)] px-4 py-3">
        <p className="text-[11px] font-medium text-[var(--color-accent-red)]">
          Live trade execution is disabled in code.
        </p>
        <p className="mt-1 text-[9px] leading-[1.55] text-[var(--color-text-muted)]">
          Enforced by {state.execution.enforcedBy}. There is no broker integration and no
          order-placement route in this codebase. Rejected job types:{" "}
          <span className="font-mono">{state.execution.forbiddenJobTypes.join(", ")}</span>
        </p>
      </div>

      {riskGate === null ? (
        <p className="px-4 py-4 text-[10px] text-[var(--color-accent-amber)]">
          Risk gate state is unavailable: {state.riskGate.reason ?? "unknown reason"}. The
          execution block above still holds — it is enforced in code, not by this data.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 border-b border-[var(--color-border-subtle)] sm:grid-cols-4">
            <OpsMetric label="Signals evaluated" value={riskGate.signalsEvaluated} />
            <OpsMetric label="Approved" value={riskGate.approvedCount} detail="became paper trade intents" />
            <OpsMetric label="Rejected" value={riskGate.rejectedCount} detail="blocked by risk rules" />
            <OpsMetric label="Risk engine" value={riskGate.riskEngineVersion} detail="deterministic, no LLM" />
          </div>

          {riskGate.topBlockedByReasons.length > 0 ? (
            <div className="border-b border-[var(--color-border-subtle)] px-4 py-3">
              <p className="mb-2 text-[8px] uppercase tracking-[.1em] text-[var(--color-text-dim)]">
                Top block reasons
              </p>
              <div className="flex flex-wrap gap-2">
                {riskGate.topBlockedByReasons.map((reason) => (
                  <span
                    key={reason.code}
                    className="rounded-full border border-[var(--color-border-default)] px-2 py-0.5 font-mono text-[8px] text-[var(--color-text-secondary)]"
                  >
                    {reason.code} ×{reason.count}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="grid gap-0 sm:grid-cols-2">
            <div className="border-b border-[var(--color-border-subtle)] px-4 py-3 sm:border-b-0 sm:border-r">
              <p className="mb-1 text-[8px] uppercase tracking-[.1em] text-[var(--color-text-dim)]">
                Latest approved intent (paper only)
              </p>
              {riskGate.latestApprovedIntent === null ? (
                <p className="text-[9px] text-[var(--color-text-muted)]">None recorded.</p>
              ) : (
                <p className="text-[9px] leading-[1.6] text-[var(--color-text-secondary)]">
                  {riskGate.latestApprovedIntent.symbol} {riskGate.latestApprovedIntent.direction}{" "}
                  · size {riskGate.latestApprovedIntent.suggestedSize} · entry{" "}
                  {riskGate.latestApprovedIntent.entryPrice} ·{" "}
                  {formatTimestamp(riskGate.latestApprovedIntent.createdAt)}
                </p>
              )}
            </div>
            <div className="px-4 py-3">
              <p className="mb-1 text-[8px] uppercase tracking-[.1em] text-[var(--color-text-dim)]">
                Latest rejected decision
              </p>
              {riskGate.latestRejectedDecision === null ? (
                <p className="text-[9px] text-[var(--color-text-muted)]">None recorded.</p>
              ) : (
                <p className="text-[9px] leading-[1.6] text-[var(--color-text-secondary)]">
                  {riskGate.latestRejectedDecision.symbol} · blocked by{" "}
                  <span className="font-mono">{riskGate.latestRejectedDecision.blockedBy.join(", ") || "—"}</span>{" "}
                  · {formatTimestamp(riskGate.latestRejectedDecision.evaluatedAt)}
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </OpsPanel>
  );
}
