/**
 * app/dashboard/page.tsx
 * Architecture-focused market intelligence dashboard.
 * No buy/sell controls. No brokerage widgets. No live trading implied.
 *
 * Layout: Header + full-width scrollable content.
 * All sections use typed static data (lib/dashboard/dashboardArchitecture.ts)
 * ready to be replaced with live API calls as each layer matures.
 */

import { Header }                  from "@/components/layout/Header";
import { DashboardHero }           from "@/components/dashboard/DashboardHero";
import { P8OperationsConsole }     from "@/components/dashboard/ops/P8OperationsConsole";
import { ArchitecturePipeline }    from "@/components/dashboard/ArchitecturePipeline";
import { SystemStatusGrid }        from "@/components/dashboard/SystemStatusGrid";
import { AgentStackOverview }      from "@/components/dashboard/AgentStackOverview";
import { RegimeIntelligencePanel } from "@/components/dashboard/RegimeIntelligencePanel";
import { StrategyResearchPanel }   from "@/components/dashboard/StrategyResearchPanel";
import { MultiAssetCoveragePanel } from "@/components/dashboard/MultiAssetCoveragePanel";
import { DataHealthPanel }         from "@/components/dashboard/DataHealthPanel";
import { PaperTradingPanel }       from "@/components/dashboard/PaperTradingPanel";
import { ExecutionReadinessPanel } from "@/components/dashboard/ExecutionReadinessPanel";
import { SystemEventLog }          from "@/components/dashboard/SystemEventLog";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function DashboardPage() {
  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <Header />

      <main className="flex-1 overflow-y-auto bg-[var(--color-surface-base)]">
        <DashboardHero />
        <P8OperationsConsole />
        <ArchitecturePipeline />
        <SystemStatusGrid />
        <AgentStackOverview />
        <RegimeIntelligencePanel />
        <StrategyResearchPanel />
        <MultiAssetCoveragePanel />
        <DataHealthPanel />
        <PaperTradingPanel />
        <ExecutionReadinessPanel />
        <SystemEventLog />
      </main>
    </div>
  );
}
