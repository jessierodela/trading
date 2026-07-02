/**
 * app/dashboard/page.tsx
 * Command-console dashboard shell. The route stays server-rendered so paper
 * trading data can be loaded from persistence before the interactive client
 * shell decides which console section is visible.
 *
 * Read-only. No order entry, no broker actions, no live trading.
 */

import { HowToReadPanel } from "@/components/dashboard/HowToReadPanel";
import { PaperTradingPanelView } from "@/components/dashboard/PaperTradingPanelView";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { Header } from "@/components/layout/Header";
import { loadPaperTradingDashboardData } from "@/lib/dashboard/paperTrading";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function DashboardPage() {
  const paperData = await loadPaperTradingDashboardData();

  return (
    <div className="flex h-screen flex-col overflow-hidden font-sans">
      <Header />
      <DashboardShell
        paperSummary={paperData.summary}
        paperPanel={<PaperTradingPanelView data={paperData} />}
        glossaryPanel={<HowToReadPanel />}
      />
    </div>
  );
}
