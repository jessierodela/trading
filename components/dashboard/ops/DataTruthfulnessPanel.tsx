// components/dashboard/ops/DataTruthfulnessPanel.tsx
// Explicitly separates real persisted data from static, mocked, missing,
// stale, and disabled content. This panel exists so static values can never
// masquerade as live ones.

import type { TruthfulnessEntry } from "@/lib/ops/systemState";
import { OpsPanel, OpsStatusPill } from "./P8OpsUI";

const realityText: Record<TruthfulnessEntry["reality"], string> = {
  real: "real",
  static: "static",
  mock: "mock",
  missing: "missing",
  stale: "stale",
  disabled: "disabled",
  display_only: "display only",
};

export function DataTruthfulnessPanel({ entries }: { entries: TruthfulnessEntry[] }) {
  return (
    <OpsPanel
      eyebrow="Data honesty"
      title="What Is Real vs Static"
    >
      <ul className="divide-y divide-[var(--color-border-subtle)]">
        {entries.map((entry, i) => (
          <li key={i} className="flex items-start gap-3 px-4 py-3">
            <OpsStatusPill status={entry.reality} label={realityText[entry.reality]} />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-[var(--color-text-primary)]">{entry.area}</p>
              <p className="mt-1 text-[9px] leading-[1.55] text-[var(--color-text-muted)]">{entry.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </OpsPanel>
  );
}
