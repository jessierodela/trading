import { PostgresPaperTradingStore, type PaperPosition } from "@/lib/execution";
import { getPgPool } from "@/lib/storage";

export type PaperTradingPanelState = "ready" | "unconfigured" | "error";

export interface PaperPnlSummary {
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  totalFees: number;
  winCount: number;
  lossCount: number;
  winRatePct: number | null;
  maxDrawdown: number | null;
  openExposure: number;
  closedTradeCount: number;
}

export interface PaperTradingDashboardData {
  state: PaperTradingPanelState;
  statusMessage: string;
  loadedAt: string | null;
  openPositions: PaperPosition[];
  closedPositions: PaperPosition[];
  summary: PaperPnlSummary;
}

export const PAPER_TRADING_ONLY_LABEL = "PAPER TRADING ONLY - NO LIVE ORDERS";

function closedPnl(position: PaperPosition): number {
  return position.realizedPnl ?? 0;
}

export function calculatePaperPnlSummary(
  openPositions: PaperPosition[],
  closedPositions: PaperPosition[],
): PaperPnlSummary {
  const totalRealizedPnl = closedPositions.reduce((sum, position) => sum + closedPnl(position), 0);
  const totalUnrealizedPnl = openPositions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
  const totalFees = [...openPositions, ...closedPositions].reduce((sum, position) => sum + position.fees, 0);
  const winCount = closedPositions.filter((position) => closedPnl(position) > 0).length;
  const lossCount = closedPositions.filter((position) => closedPnl(position) < 0).length;
  const closedTradeCount = closedPositions.length;
  const openExposure = openPositions.reduce(
    (sum, position) => sum + Math.abs(position.quantity * position.markPrice),
    0,
  );

  let runningPnl = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const position of [...closedPositions].sort((a, b) => (a.closedAt ?? "").localeCompare(b.closedAt ?? ""))) {
    runningPnl += closedPnl(position);
    peak = Math.max(peak, runningPnl);
    maxDrawdown = Math.max(maxDrawdown, peak - runningPnl);
  }

  return {
    totalRealizedPnl,
    totalUnrealizedPnl,
    totalFees,
    winCount,
    lossCount,
    winRatePct: closedTradeCount > 0 ? winCount / closedTradeCount * 100 : null,
    maxDrawdown: closedTradeCount > 0 ? maxDrawdown : null,
    openExposure,
    closedTradeCount,
  };
}

export function createPaperTradingDashboardData(
  openPositions: PaperPosition[],
  closedPositions: PaperPosition[],
  state: PaperTradingPanelState = "ready",
  statusMessage = "Loaded from paper trading persistence.",
  loadedAt: string | null = new Date().toISOString(),
): PaperTradingDashboardData {
  return {
    state,
    statusMessage,
    loadedAt,
    openPositions,
    closedPositions,
    summary: calculatePaperPnlSummary(openPositions, closedPositions),
  };
}

export async function loadPaperTradingDashboardData(): Promise<PaperTradingDashboardData> {
  if (!process.env.SUPABASE_DB_URL && !process.env.DATABASE_URL) {
    return createPaperTradingDashboardData(
      [],
      [],
      "unconfigured",
      "Set SUPABASE_DB_URL or DATABASE_URL to load persisted paper trading state.",
      null,
    );
  }

  try {
    const store = new PostgresPaperTradingStore(getPgPool());
    const [openPositions, closedPositions] = await Promise.all([
      store.listPositions({ status: "open" }),
      store.listPositions({ status: "closed" }),
    ]);
    return createPaperTradingDashboardData(openPositions, closedPositions);
  } catch (err) {
    return createPaperTradingDashboardData(
      [],
      [],
      "error",
      err instanceof Error ? err.message : String(err),
      null,
    );
  }
}

export function formatPaperCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatPaperNumber(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

export function formatPaperPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${value.toFixed(1)}%`;
}

export function formatPaperTimestamp(value: string | null | undefined): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().replace(".000Z", "Z");
}

export function metadataStringArray(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  return Array.isArray(value) ? value.map(String) : [];
}

export function metadataText(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value : "-";
}

