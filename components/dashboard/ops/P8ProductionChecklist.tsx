import type { P8OpsSummary } from "@/lib/ops/p8Types";
import { OpsPanel, OpsStatusPill } from "./P8OpsUI";

export function P8ProductionChecklist({ data }: { data: P8OpsSummary }) {
  const passCount = data.readiness.filter((item) => item.status === "pass").length;
  return (
    <OpsPanel title="Production Readiness" eyebrow="Evidence-based checklist" action={<span className="font-mono text-[10px] text-[var(--color-text-muted)]">{passCount}/{data.readiness.length} pass</span>}>
      <ul className="divide-y divide-[var(--color-border-subtle)]">
        {data.readiness.map((item) => (
          <li key={item.label} className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="text-[10px] text-[var(--color-text-primary)]">{item.label}</p>
              <p className="mt-1 text-[9px] leading-4 text-[var(--color-text-muted)]">{item.detail}</p>
            </div>
            <OpsStatusPill status={item.status} />
          </li>
        ))}
      </ul>
    </OpsPanel>
  );
}
