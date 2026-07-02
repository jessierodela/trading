/**
 * app/dashboard/page.tsx
 * Operations-state dashboard: what the platform is, what is running, what is
 * stale or blocked, and what happens next.
 *
 * Layout:
 *  1. PlatformOverview        — what this system does, current phase (static copy, code-level facts)
 *  2–8. SystemStateConsole    — live sections fed by one /api/ops/system-state poll:
 *       flow map, operations state, jobs & pipeline, data truthfulness,
 *       research live state, risk/execution safety, what needs attention
 *  ·  PaperTradingPanel       — real persisted simulated positions and PnL
 *  ·  ArchitectureReference   — static design/research documentation, explicitly labeled
 *  9. HowToReadPanel          — glossary and trust rules
 *
 * Read-only. No order entry, no broker actions, no live trading.
 */

import { Header } from "@/components/layout/Header";
import { PlatformOverview } from "@/components/dashboard/PlatformOverview";
import { SystemStateConsole } from "@/components/dashboard/ops/SystemStateConsole";
import { PaperTradingPanel } from "@/components/dashboard/PaperTradingPanel";
import { ArchitectureReference } from "@/components/dashboard/ArchitectureReference";
import { HowToReadPanel } from "@/components/dashboard/HowToReadPanel";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function DashboardPage() {
  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <Header />

      <main className="flex-1 overflow-y-auto bg-[var(--color-surface-base)]">
        <PlatformOverview />
        <SystemStateConsole />
        <PaperTradingPanel />
        <ArchitectureReference />
        <HowToReadPanel />
      </main>
    </div>
  );
}
