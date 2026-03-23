/**
 * app/dashboard/page.tsx
 * Dashboard layout — all live data is fetched inside client components.
 * This page itself stays a Server Component (no "use client" needed here).
 *
 * Layout strategy:
 *  - Mobile (<768px): single scrollable column — Watchlist → Signals → Agents → Config → Log
 *  - Desktop (≥768px): original 3-column fixed layout — Sidebar | main | SignalsPanel
 */

import { Header }           from "@/components/layout/Header";
import { Sidebar }          from "@/components/layout/Sidebar";
import { SignalsPanel }     from "@/components/layout/SignalsPanel";
import { StatsBar }         from "@/components/dashboard/StatsBar";
import { LiveAgentGrid }    from "@/components/agents/LiveAgentGrid";
import { ActivityLog }      from "@/components/dashboard/ActivityLog";
import IndicatorSettings    from "@/components/IndicatorSettings";

export default function DashboardPage() {
  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <Header />

      <div className="flex flex-1 overflow-hidden">

        {/* ── DESKTOP: Left sidebar (hidden on mobile) ── */}
        <div className="hidden md:flex md:flex-col md:flex-shrink-0">
          <Sidebar />
        </div>

        {/* ── MOBILE: Single scrollable column (hidden on desktop) ── */}
        <div className="flex flex-col w-full overflow-y-auto md:hidden">

          {/* Watchlist */}
          <Sidebar />

          {/* Stats */}
          <StatsBar />

          {/* Signals */}
          <div className="border-b border-[var(--color-border-default)] px-[18px] py-[14px]">
            <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.16em] mb-3">SIGNALS</p>
            <SignalsPanel />
          </div>

          {/* Agents */}
          <div className="border-b border-[var(--color-border-default)] px-[18px] py-[14px]">
            <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.16em] mb-3">AGENTS</p>
            <LiveAgentGrid />
          </div>

          {/* Indicator config */}
          <div className="border-b border-[var(--color-border-default)] px-[18px] py-[14px]">
            <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.16em] mb-3">INDICATOR CONFIG</p>
            <IndicatorSettings />
          </div>

          {/* Activity log */}
          <ActivityLog />
        </div>

        {/* ── DESKTOP: Center main content (hidden on mobile) ── */}
        <main className="hidden md:flex md:flex-col md:flex-1 overflow-hidden">
          <StatsBar />

          <div className="flex flex-col flex-1 overflow-y-auto">
            <div className="border-b border-[var(--color-border-default)] px-[18px] py-[14px]">
              <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.16em] mb-3">AGENTS</p>
              <LiveAgentGrid />
            </div>

            <div className="border-b border-[var(--color-border-default)] px-[18px] py-[14px]">
              <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.16em] mb-3">
                INDICATOR CONFIG
              </p>
              <IndicatorSettings />
            </div>

            <ActivityLog />
          </div>
        </main>

        {/* ── DESKTOP: Right signals panel (hidden on mobile) ── */}
        <div className="hidden md:flex md:flex-col md:flex-shrink-0">
          <SignalsPanel />
        </div>

      </div>
    </div>
  );
}
