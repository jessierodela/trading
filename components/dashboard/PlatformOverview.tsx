// components/dashboard/PlatformOverview.tsx
// Legacy static overview kept for routes/tests that still import it. The new
// dashboard shell renders OverviewSection with the same copy and phase data.

import { Pulse } from "@/components/ui/Pulse";
import { PHASES, PLATFORM_DESCRIPTION, PLATFORM_READ_ONLY_NOTE, phaseTone } from "./overviewContent";

export function PlatformOverview() {
  return (
    <section className="border-b border-[var(--color-border-default)] px-4 py-7 sm:px-6">
      <div className="flex items-start gap-3">
        <Pulse />
        <div className="min-w-0">
          <p className="mb-2 text-[9px] uppercase tracking-[.18em] text-[var(--color-text-dim)]">
            Section 1 &middot; Platform Overview
          </p>
          <h1 className="text-[20px] font-light leading-tight tracking-tight text-[var(--color-text-primary)]">
            Trading Intelligence Platform - Operations Dashboard
          </h1>
          <p className="mt-3 max-w-[720px] text-[12px] leading-[1.7] text-[var(--color-text-secondary)]">
            {PLATFORM_DESCRIPTION}
          </p>
          <p className="mt-2 max-w-[720px] text-[10px] leading-[1.6] text-[var(--color-text-muted)]">
            {PLATFORM_READ_ONLY_NOTE}
          </p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {PHASES.map((phase) => (
          <span
            key={phase.label}
            title={phase.note}
            className={`rounded-full border px-[10px] py-[4px] text-[9px] uppercase tracking-[.1em] ${phaseTone[phase.status]}`}
          >
            {phase.label}: {phase.status}
          </span>
        ))}
      </div>
    </section>
  );
}
