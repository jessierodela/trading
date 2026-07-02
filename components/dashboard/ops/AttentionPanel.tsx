// components/dashboard/ops/AttentionPanel.tsx
// Prioritized issue list generated from real automated checks in
// lib/ops/systemState.ts; never hand-written status claims.

import type { AttentionItem } from "@/lib/ops/systemState";
import { OpsStatusPill } from "./P8OpsUI";

export function AttentionPanel({ items }: { items: AttentionItem[] }) {
  const openCount = items.filter((item) => item.severity !== "info").length;
  const countTone = items.some((item) => item.severity === "critical") ? "critical" : openCount > 0 ? "warning" : "pass";

  return (
    <section className="px-5 py-8 sm:px-10">
      <p className="mb-1 text-[11px] uppercase tracking-[.16em] text-[var(--color-text-dim)]">
        03 &middot; Attention
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[24px] font-semibold tracking-normal text-[var(--color-text-primary)]">
          What needs attention
        </h2>
        <OpsStatusPill status={countTone} label={`${openCount} open`} />
      </div>
      <p className="mt-2 text-[14px] text-[var(--color-text-muted)]">
        Generated from automated checks; never hand-written status claims.
      </p>

      <ul className="mt-6 flex flex-col gap-3">
        {items.map((item) => (
          <li
            key={`${item.source}:${item.title}`}
            className="flex flex-col gap-4 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-surface-card)] px-5 py-[18px] sm:flex-row sm:items-start"
          >
            <OpsStatusPill status={item.severity === "info" ? "active" : item.severity} label={item.severity === "info" ? "Info" : item.severity} />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold text-[var(--color-text-primary)]">{item.title}</p>
              <p className="mt-2 text-[13px] leading-[1.55] text-[var(--color-text-muted)]">{item.detail}</p>
              <p className="mt-2 font-mono text-[11px] tracking-[.06em] text-[var(--color-text-dim)]">
                check: {item.source}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
