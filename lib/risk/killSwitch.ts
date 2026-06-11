import type { Position, PnlSnapshot, RegimeContext, RiskConfig } from "./types";

export interface KillSwitchDecision {
  active: boolean;
  reason: string;
  blockedBy: string[];
}

interface KillSwitchInput {
  accountEquity: number;
  openPositions: Position[];
  recentPnL: PnlSnapshot[];
  regime: RegimeContext;
  config: RiskConfig;
  nowTs: string;
}

function startOfUtcDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfUtcWeek(timestamp: number): number {
  const dayStart = startOfUtcDay(timestamp);
  const day = new Date(dayStart).getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  return dayStart - daysSinceMonday * 24 * 60 * 60 * 1000;
}

function realizedSince(recentPnL: PnlSnapshot[], startMs: number, endMs: number): number {
  return recentPnL.reduce((sum, snapshot) => {
    const timestamp = Date.parse(snapshot.ts);
    if (!Number.isFinite(timestamp) || timestamp < startMs || timestamp > endMs) return sum;
    return sum + (Number.isFinite(snapshot.realizedPnl) ? snapshot.realizedPnl : 0);
  }, 0);
}

function latestConsecutiveLosses(recentPnL: PnlSnapshot[]): number | null {
  return recentPnL
    .filter((snapshot) => Number.isFinite(Date.parse(snapshot.ts)) && snapshot.consecutiveLosses !== undefined)
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0]?.consecutiveLosses ?? null;
}

function exceedsOpenPositionDrawdown(positions: Position[], maxDrawdownPct: number | undefined): boolean {
  if (maxDrawdownPct === undefined || !Number.isFinite(maxDrawdownPct) || maxDrawdownPct <= 0) return false;
  return positions.some((position) => {
    const entryNotional = Math.abs(position.quantity * position.entryPrice);
    if (!Number.isFinite(entryNotional) || entryNotional <= 0) return false;
    return Math.max(0, -position.unrealizedPnl) / entryNotional >= maxDrawdownPct;
  });
}

export function evaluateKillSwitch(input: KillSwitchInput): KillSwitchDecision {
  const blockedBy: string[] = [];
  const nowMs = Date.parse(input.nowTs);
  const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : Date.parse(input.regime.ts);

  if (input.config.killSwitchEnabled) blockedBy.push("KILL_SWITCH_ENABLED");

  if (Number.isFinite(effectiveNowMs) && input.accountEquity > 0) {
    const dailyRealizedPnl = realizedSince(input.recentPnL, startOfUtcDay(effectiveNowMs), effectiveNowMs);
    if (
      input.config.maxDailyLossPct > 0 &&
      dailyRealizedPnl <= -input.accountEquity * input.config.maxDailyLossPct
    ) {
      blockedBy.push("MAX_DAILY_LOSS");
    }

    if (input.config.maxWeeklyLossPct !== undefined && input.config.maxWeeklyLossPct > 0) {
      const weeklyRealizedPnl = realizedSince(input.recentPnL, startOfUtcWeek(effectiveNowMs), effectiveNowMs);
      if (weeklyRealizedPnl <= -input.accountEquity * input.config.maxWeeklyLossPct) {
        blockedBy.push("MAX_WEEKLY_LOSS");
      }
    }
  }

  const consecutiveLosses = latestConsecutiveLosses(input.recentPnL);
  if (
    input.config.maxConsecutiveLosses !== undefined &&
    input.config.maxConsecutiveLosses > 0 &&
    consecutiveLosses !== null &&
    consecutiveLosses >= input.config.maxConsecutiveLosses
  ) {
    blockedBy.push("MAX_CONSECUTIVE_LOSSES");
  }

  if (!Number.isFinite(input.regime.reliability) || input.regime.reliability <= 0) {
    blockedBy.push("REGIME_RELIABILITY_COLLAPSE");
  }
  if (exceedsOpenPositionDrawdown(input.openPositions, input.config.maxOpenPositionDrawdownPct)) {
    blockedBy.push("MAX_OPEN_POSITION_DRAWDOWN");
  }

  const reasons: Record<string, string> = {
    KILL_SWITCH_ENABLED: "Manual kill switch is enabled",
    MAX_DAILY_LOSS: "Daily loss limit exceeded",
    MAX_WEEKLY_LOSS: "Weekly loss limit exceeded",
    MAX_CONSECUTIVE_LOSSES: "Maximum consecutive losses exceeded",
    REGIME_RELIABILITY_COLLAPSE: "Regime reliability collapsed",
    MAX_OPEN_POSITION_DRAWDOWN: "Open position drawdown limit exceeded",
  };

  return {
    active: blockedBy.length > 0,
    reason: blockedBy.length > 0 ? reasons[blockedBy[0]] : "Kill switch inactive",
    blockedBy,
  };
}
