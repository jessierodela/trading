import * as React from "react";
import { PaperTradingPanelView } from "./PaperTradingPanelView";
import { loadPaperTradingDashboardData } from "@/lib/dashboard/paperTrading";

export async function PaperTradingPanel() {
  const data = await loadPaperTradingDashboardData();
  return <PaperTradingPanelView data={data} />;
}
