import type { ReactNode } from "react";

type Tone = "good" | "active" | "warn" | "bad" | "neutral";

const toneClass: Record<Tone, string> = {
  good: "border-[var(--color-accent-green)]/40 text-[var(--color-accent-green)] bg-[var(--color-accent-green)]/5",
  active: "border-[var(--color-accent-blue)]/40 text-[var(--color-accent-blue)] bg-[var(--color-accent-blue)]/5",
  warn: "border-[var(--color-accent-amber)]/40 text-[var(--color-accent-amber)] bg-[var(--color-accent-amber)]/5",
  bad: "border-[var(--color-accent-red)]/40 text-[var(--color-accent-red)] bg-[var(--color-accent-red)]/5",
  neutral: "border-[var(--color-border-default)] text-[var(--color-text-muted)] bg-[var(--color-surface-panel)]",
};

export function toneForStatus(status: string): Tone {
  if (["healthy", "succeeded", "pass", "idle", "recently_active", "real"].includes(status)) return "good";
  if (["active", "running", "display_only"].includes(status)) return "active";
  if (["queued", "stale", "partial", "attention", "warning", "mock"].includes(status)) return "warn";
  if (["blocked", "failed", "dead", "not_configured", "critical", "missing"].includes(status)) return "bad";
  return "neutral";
}

export function OpsStatusPill({ status, label }: { status: string; label?: string }) {
  return (
    <span className={`inline-flex min-h-5 items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[9px] uppercase ${toneClass[toneForStatus(status)]}`}>
      {label ?? status.replaceAll("_", " ")}
    </span>
  );
}

export function OpsPanel({
  title,
  eyebrow,
  action,
  children,
  className = "",
}: {
  title: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-md border border-[var(--color-border-default)] bg-[var(--color-surface-card)] ${className}`}>
      <header className="flex min-h-14 items-center justify-between gap-3 border-b border-[var(--color-border-subtle)] px-4 py-3">
        <div className="min-w-0">
          {eyebrow ? <p className="text-[9px] uppercase text-[var(--color-text-dim)]">{eyebrow}</p> : null}
          <h3 className="mt-0.5 text-[13px] font-medium text-[var(--color-text-primary)]">{title}</h3>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function OpsMetric({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return (
    <div className="min-w-0 border-r border-[var(--color-border-subtle)] px-3 py-3 last:border-r-0">
      <p className="text-[9px] uppercase text-[var(--color-text-dim)]">{label}</p>
      <div className="mt-1 truncate font-mono text-[15px] text-[var(--color-text-primary)]">{value}</div>
      {detail ? <p className="mt-1 truncate text-[9px] text-[var(--color-text-muted)]">{detail}</p> : null}
    </div>
  );
}

export function formatTimestamp(value: string | null): string {
  if (!value) return "Not observed";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatAge(seconds: number | null): string {
  if (seconds === null) return "None";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function formatDuration(value: number | null): string {
  if (value === null) return "-";
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

export function shortId(value: string | null): string {
  if (!value) return "-";
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}
