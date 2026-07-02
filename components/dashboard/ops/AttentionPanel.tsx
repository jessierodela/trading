// components/dashboard/ops/AttentionPanel.tsx
// Prioritized issue list generated from real automated checks in
// lib/ops/systemState.ts — never hand-written status claims.

import type { AttentionItem } from "@/lib/ops/systemState";
import { OpsPanel, OpsStatusPill } from "./P8OpsUI";

export function AttentionPanel({ items }: { items: AttentionItem[] }) {
  return (
    <OpsPanel
      eyebrow="Generated from automated checks"
      title="What Needs Attention"
      action={<OpsStatusPill
        status={items.some((i) => i.severity === "critical") ? "critical" : items.some((i) => i.severity === "warning") ? "warning" : "pass"}
        label={`${items.filter((i) => i.severity !== "info").length} open`}
      />}
    >
      <ul className="divide-y divide-[var(--color-border-subtle)]">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-3 px-4 py-3">
            <OpsStatusPill status={item.severity} label={item.severity} />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium text-[var(--color-text-primary)]">{item.title}</p>
              <p className="mt-1 text-[9px] leading-[1.55] text-[var(--color-text-muted)]">{item.detail}</p>
              <p className="mt-1 text-[8px] uppercase tracking-[.08em] text-[var(--color-text-dim)]">
                check: {item.source}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </OpsPanel>
  );
}
