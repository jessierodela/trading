import { Header } from "@/components/layout/Header";
import { Sidebar } from "@/components/layout/Sidebar";
import { SignalsPanel } from "@/components/layout/SignalsPanel";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { AgentGrid } from "@/components/agents/AgentGrid";
import { ActivityLog } from "@/components/dashboard/ActivityLog";
import { WATCHLIST } from "@/config/assets";
import { AGENTS, ACTIVITY_LOG } from "@/config/agents";
import { ALERTS } from "@/config/alerts";

export default function DashboardPage() {
  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <Header />

      <div className="flex flex-1 overflow-hidden">
        {/* Left — Watchlist */}
        <Sidebar watchlist={WATCHLIST} />

        {/* Center — Main content */}
        <main className="flex flex-col flex-1 overflow-hidden">
          <StatsBar />

          <div className="flex flex-col flex-1 overflow-hidden">
            {/* Agent cards */}
            <div className="border-b border-[var(--color-border-default)] px-[18px] py-[14px]">
              <p className="text-[9px] text-[var(--color-text-dim)] tracking-[.16em] mb-3">AGENTS</p>
              <AgentGrid agents={AGENTS} />
            </div>

            {/* Activity log */}
            <ActivityLog entries={ACTIVITY_LOG} />
          </div>
        </main>

        {/* Right — Alerts */}
        <SignalsPanel alerts={ALERTS} />
      </div>
    </div>
  );
}
