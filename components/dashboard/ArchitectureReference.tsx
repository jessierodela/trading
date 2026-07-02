// components/dashboard/ArchitectureReference.tsx
// Groups the hand-written design/research panels behind one explicit banner so
// static content can never be mistaken for live state. Everything in here is
// documentation of design intent and past research findings.

import { ArchitecturePipeline } from "./ArchitecturePipeline";
import { AgentStackOverview } from "./AgentStackOverview";
import { RegimeIntelligencePanel } from "./RegimeIntelligencePanel";
import { StrategyResearchPanel } from "./StrategyResearchPanel";
import { MultiAssetCoveragePanel } from "./MultiAssetCoveragePanel";

export function ArchitectureReference() {
  return (
    <div className="border-b border-[var(--color-border-default)]">
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border-default)] bg-[var(--color-surface-panel)] px-4 py-4 sm:px-6">
        <span className="rounded-full border border-[var(--color-accent-amber)]/50 px-[10px] py-[4px] text-[9px] uppercase tracking-[.12em] text-[var(--color-accent-amber)]">
          Static Reference
        </span>
        <div className="min-w-0">
          <h2 className="text-[14px] font-medium text-[var(--color-text-primary)]">
            Architecture & Research Reference
          </h2>
          <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
            Hand-written descriptions of the system design and research findings. Nothing in
            this section reads live state — for current run status, use System State above.
          </p>
        </div>
      </div>

      <ArchitecturePipeline />
      <AgentStackOverview />
      <RegimeIntelligencePanel />
      <StrategyResearchPanel />
      <MultiAssetCoveragePanel />
    </div>
  );
}
