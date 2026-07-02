/**
 * lib/risk/adapters/scheduledRiskInput.ts
 *
 * P11: converts a scheduled-path strategy signal into a deterministic
 * RiskInput, sourcing open positions and recent PnL from the paper trading
 * store. This adapter is intentionally scoped to the paper-only scheduled
 * worker path — it reads PaperTradingStore directly and assumes paper
 * positions/fills are the only position source. A future live/broker-
 * connected path must not reuse this file; it should get its own adapter
 * so paper-only assumptions never leak into a live risk input.
 *
 * Deterministic: no OpenAI, no network calls beyond the paper store reads
 * the caller already has open.
 */
import { paperPositionToRiskPosition, type PaperTradingStore, type PaperPosition } from "@/lib/execution";
import type { PnlSnapshot, Position, RegimeContext, RiskConfig, RiskInput, StrategySignal } from "../types";

/** Covers both the daily and weekly loss-limit lookback windows the risk engine checks. */
const DEFAULT_RECENT_PNL_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000;

export interface ScheduledRiskInputContext {
  signal: StrategySignal;
  /** Latest regime context for the signal's symbol, or null if unavailable/stale. */
  regime: RegimeContext | null;
  accountEquity: number;
  config: RiskConfig;
  nowTs: string;
  paperStore: PaperTradingStore;
  recentPnLLookbackMs?: number;
}

/**
 * Strategies fail-open on missing regime context (see quant/types.ts); the
 * risk engine must fail closed instead. A null regime becomes a zero-
 * reliability CHOP context, which blocks via REGIME_RELIABILITY_LOW rather
 * than silently defaulting to an approving regime.
 */
function fallbackRegime(nowTs: string): RegimeContext {
  return { regime: "CHOP", reliability: 0, ts: nowTs };
}

function consecutiveLosses(closedPositions: PaperPosition[]): number {
  const sorted = [...closedPositions]
    .filter((position) => position.closedAt !== null && Number.isFinite(Date.parse(position.closedAt)))
    .sort((a, b) => Date.parse(b.closedAt!) - Date.parse(a.closedAt!));
  let streak = 0;
  for (const position of sorted) {
    if ((position.realizedPnl ?? 0) < 0) streak++;
    else break;
  }
  return streak;
}

function buildRecentPnL(
  closedPositions: PaperPosition[],
  accountEquity: number,
  nowTs: string,
  lookbackMs: number,
): PnlSnapshot[] {
  const nowMs = Date.parse(nowTs);
  const losses = consecutiveLosses(closedPositions);
  return closedPositions
    .filter((position) => {
      if (position.closedAt === null) return false;
      const closedMs = Date.parse(position.closedAt);
      return (
        Number.isFinite(closedMs) &&
        Number.isFinite(nowMs) &&
        closedMs <= nowMs &&
        nowMs - closedMs <= lookbackMs
      );
    })
    .map((position) => ({
      ts: position.closedAt as string,
      realizedPnl: position.realizedPnl ?? 0,
      unrealizedPnl: 0,
      equity: accountEquity,
      consecutiveLosses: losses,
    }));
}

export async function buildScheduledRiskInput(context: ScheduledRiskInputContext): Promise<RiskInput> {
  const [openPaperPositions, closedPaperPositions] = await Promise.all([
    context.paperStore.listPositions({ status: "open" }),
    context.paperStore.listPositions({ status: "closed" }),
  ]);
  const openPositions: Position[] = openPaperPositions.map(paperPositionToRiskPosition);
  const lookbackMs = context.recentPnLLookbackMs ?? DEFAULT_RECENT_PNL_LOOKBACK_MS;
  const recentPnL = buildRecentPnL(closedPaperPositions, context.accountEquity, context.nowTs, lookbackMs);

  return {
    signal: context.signal,
    regime: context.regime ?? fallbackRegime(context.nowTs),
    accountEquity: context.accountEquity,
    openPositions,
    recentPnL,
    config: context.config,
    nowTs: context.nowTs,
  };
}
