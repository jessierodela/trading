/**
 * app/dashboard/page.tsx
 * Dashboard layout — all live data is fetched inside client components.
 * This page itself stays a Server Component (no "use client" needed here).
 */

import { Header }             from "@/components/layout/Header";
import { Sidebar }            from "@/components/layout/Sidebar";
import { SignalsPanel }       from "@/components/layout/SignalsPanel";
import { StatsBar }           from "@/components/dashboard/StatsBar";
import { AgentGrid }          from "@/components/agents/AgentGrid";
import { ActivityLog }        from "@/components/dashboard/ActivityLog";
import IndicatorSettings      from "@/components/IndicatorSettings";
import { AGENTS }             from "@/config/agents";


export default function DashboardPage() {
  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <Header />

      <div className="flex flex-1 overflow-hidden">
        {/* Left — Live Watchlist (polls Polygon every 30s) */}
        <Sidebar />

        {/* Center — Main content */}
        <main className="flex flex-col flex-1 overflow-hidden">
          {/* Stats bar polls /api/signals every 30s */}
          <StatsBar />

          <div className="flex flex-col flex-1 overflow-y-auto">
            {/* Agent cards */}
            <div className="border-b border-[var(--color-border-default)] px-[18px] py-[14px]">
              <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.16em] mb-3">AGENTS</p>
              <AgentGrid agents={AGENTS} />
            </div>

            {/* Indicator config — lets user toggle which indicators fetch per asset */}
            <div className="border-b border-[var(--color-border-default)] px-[18px] py-[14px]">
              <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.16em] mb-3">
                INDICATOR CONFIG
              </p>
              <IndicatorSettings />
            </div>

            {/* Activity log polls /api/signals every 30s */}
            <ActivityLog />
          </div>
        </main>

        {/* Right — Live signals panel polls /api/signals every 60s */}
        <SignalsPanel />
      </div>
    </div>
  );
}
