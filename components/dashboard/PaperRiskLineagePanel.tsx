import * as React from "react";
import type { PaperPosition } from "@/lib/execution";
import {
  metadataStringArray,
  metadataText,
  PAPER_TRADING_ONLY_LABEL,
} from "@/lib/dashboard/paperTrading";

function riskDecisionValue(metadata: Record<string, unknown>, key: string): string {
  const riskDecision = metadata.riskDecision;
  if (typeof riskDecision !== "object" || riskDecision === null || Array.isArray(riskDecision)) return "-";
  const value = (riskDecision as Record<string, unknown>)[key];
  if (Array.isArray(value)) return value.length > 0 ? value.map(String).join(", ") : "-";
  if (typeof value === "boolean") return value ? "true" : "false";
  return value === undefined || value === null ? "-" : String(value);
}

function tradeIntentMetadata(position: PaperPosition): Record<string, unknown> {
  const metadata = position.metadata.tradeIntentMetadata;
  return typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

export function PaperRiskLineagePanel({ positions }: { positions: PaperPosition[] }) {
  const sample = positions.slice(0, 4);

  return (
    <div className="bg-[var(--color-surface-card)] border border-[var(--color-border-default)] rounded">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[var(--color-border-subtle)]">
        <p className="text-[8px] text-[var(--color-text-dim)] tracking-[.12em] uppercase">
          Risk And Strategy Lineage
        </p>
        <span className="text-[8px] text-[var(--color-accent-amber)] tracking-[.12em] uppercase">
          {PAPER_TRADING_ONLY_LABEL}
        </span>
      </div>
      {sample.length === 0 ? (
        <p className="px-4 py-5 text-[10px] text-[var(--color-text-muted)]">
          No paper lineage is available yet. Persisted paper positions will show trade intent, signal, strategy, feature, risk, and regime metadata here.
        </p>
      ) : (
        <div className="divide-y divide-[var(--color-border-subtle)]">
          {sample.map((position) => {
            const intentMetadata = tradeIntentMetadata(position);
            const sourceSignals = metadataStringArray(position.metadata, "sourceSignalIds");
            const regime = metadataText(intentMetadata, "regime");
            return (
              <div key={position.id ?? position.orderId} className="px-4 py-4">
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <span className="text-[10px] text-[var(--color-text-primary)] font-medium">{position.symbol}</span>
                  <span className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase">{position.status}</span>
                  <span className="text-[8px] text-[var(--color-accent-blue)] tracking-[.1em] uppercase">{metadataText(position.metadata, "strategyId")}</span>
                </div>
                <dl className="grid grid-cols-1 md:grid-cols-4 gap-x-4 gap-y-3">
                  <div>
                    <dt className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase">Trade Intent</dt>
                    <dd className="text-[10px] text-[var(--color-text-secondary)] font-mono break-all">{position.tradeIntentId}</dd>
                  </div>
                  <div>
                    <dt className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase">Source Signals</dt>
                    <dd className="text-[10px] text-[var(--color-text-secondary)]">{sourceSignals.length > 0 ? sourceSignals.join(", ") : "-"}</dd>
                  </div>
                  <div>
                    <dt className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase">Strategy / Feature</dt>
                    <dd className="text-[10px] text-[var(--color-text-secondary)]">
                      {metadataText(position.metadata, "strategyVersion")} / {metadataText(position.metadata, "featureVersion")}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase">Risk Version</dt>
                    <dd className="text-[10px] text-[var(--color-text-secondary)]">{metadataText(position.metadata, "riskVersion")}</dd>
                  </div>
                  <div>
                    <dt className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase">Risk Approved</dt>
                    <dd className="text-[10px] text-[var(--color-text-secondary)]">{riskDecisionValue(position.metadata, "approved")}</dd>
                  </div>
                  <div>
                    <dt className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase">Blocked By</dt>
                    <dd className="text-[10px] text-[var(--color-text-secondary)]">{riskDecisionValue(position.metadata, "blockedBy")}</dd>
                  </div>
                  <div>
                    <dt className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase">Warnings</dt>
                    <dd className="text-[10px] text-[var(--color-text-secondary)]">{riskDecisionValue(position.metadata, "warnings")}</dd>
                  </div>
                  <div>
                    <dt className="text-[8px] text-[var(--color-text-dim)] tracking-[.1em] uppercase">Regime Metadata</dt>
                    <dd className="text-[10px] text-[var(--color-text-secondary)]">{regime}</dd>
                  </div>
                </dl>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
