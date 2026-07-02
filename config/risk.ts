/**
 * config/risk.ts
 *
 * Deterministic, env-driven risk parameters for the scheduled (paper-only)
 * risk gate. No OpenAI, no network calls — every value here is a plain
 * number/boolean read from process.env with a safe fallback.
 */
import type { RiskConfig } from "@/lib/risk/types";

const DEFAULT_ACCOUNT_EQUITY_USD = 10_000;

function envNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function envBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  return raw.trim().toLowerCase() === "true";
}

function envStringList(env: NodeJS.ProcessEnv, key: string, fallback: string[]): string[] {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  return raw.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
}

/** Paper account equity used to size scheduled, risk-gated trade intents. */
export function getScheduledAccountEquity(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber(env, "PAPER_ACCOUNT_EQUITY_USD", DEFAULT_ACCOUNT_EQUITY_USD);
}

/** Deterministic risk config for the scheduled strategies.evaluate risk gate. */
export function getScheduledRiskConfig(env: NodeJS.ProcessEnv = process.env): RiskConfig {
  return {
    enabled: envBoolean(env, "RISK_ENGINE_ENABLED", true),
    maxRiskPerTradePct: envNumber(env, "RISK_MAX_RISK_PER_TRADE_PCT", 0.01),
    maxDailyLossPct: envNumber(env, "RISK_MAX_DAILY_LOSS_PCT", 0.03),
    maxWeeklyLossPct: envNumber(env, "RISK_MAX_WEEKLY_LOSS_PCT", 0.08),
    maxOpenPositions: envNumber(env, "RISK_MAX_OPEN_POSITIONS", 3),
    maxSymbolExposurePct: envNumber(env, "RISK_MAX_SYMBOL_EXPOSURE_PCT", 0.5),
    maxPortfolioExposurePct: envNumber(env, "RISK_MAX_PORTFOLIO_EXPOSURE_PCT", 1),
    minRegimeReliability: envNumber(env, "RISK_MIN_REGIME_RELIABILITY", 0.5),
    blockedRegimes: envStringList(env, "RISK_BLOCKED_REGIMES", []),
    allowLong: envBoolean(env, "RISK_ALLOW_LONG", true),
    allowShort: envBoolean(env, "RISK_ALLOW_SHORT", true),
    allowDefaultStopFallback: envBoolean(env, "RISK_ALLOW_DEFAULT_STOP_FALLBACK", true),
    defaultStopLossPct: envNumber(env, "RISK_DEFAULT_STOP_LOSS_PCT", 0.02),
    defaultTakeProfitPct: envNumber(env, "RISK_DEFAULT_TAKE_PROFIT_PCT", 0.04),
    maxLeverage: envNumber(env, "RISK_MAX_LEVERAGE", 1),
    staleSignalMaxAgeMs: envNumber(env, "RISK_STALE_SIGNAL_MAX_AGE_MS", 60 * 60 * 1000),
    duplicateCooldownMs: envNumber(env, "RISK_DUPLICATE_COOLDOWN_MS", 60 * 60 * 1000),
    maxConsecutiveLosses: envNumber(env, "RISK_MAX_CONSECUTIVE_LOSSES", 3),
    highVolSizeMultiplier: envNumber(env, "RISK_HIGH_VOL_SIZE_MULTIPLIER", 0.5),
    chopSizeMultiplier: envNumber(env, "RISK_CHOP_SIZE_MULTIPLIER", 0.25),
    newsShockBlocksTrading: envBoolean(env, "RISK_NEWS_SHOCK_BLOCKS_TRADING", true),
    killSwitchEnabled: envBoolean(
      env,
      "PAPER_TRADING_KILL_SWITCH_ENABLED",
      envBoolean(env, "PAPER_TRADING_KILL_SWITCH", false),
    ),
    maxOpenPositionDrawdownPct: envNumber(env, "RISK_MAX_OPEN_POSITION_DRAWDOWN_PCT", 0.1),
  };
}
