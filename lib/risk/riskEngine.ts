import { evaluateKillSwitch } from "./killSwitch";
import { calculatePositionSize, positionNotional } from "./positionSizing";
import { calculateStopLoss, calculateTakeProfit } from "./stops";
import type { RiskDecision, RiskInput, RiskPositionSide } from "./types";

const BLOCK_REASONS: Record<string, string> = {
  NO_TRADE_SIGNAL: "Signal is not an executable trade trigger",
  ACCOUNT_EQUITY_INVALID: "Account equity must be positive",
  ENTRY_PRICE_MISSING: "Signal entry price is missing or invalid",
  STOP_LOSS_MISSING: "A valid stop or invalidation level is required",
  SIGNAL_TIMESTAMP_INVALID: "Signal timestamp is invalid",
  SIGNAL_STALE: "Signal is stale",
  DUPLICATE_COOLDOWN: "Duplicate same-direction entry is inside the cooldown window",
  MAX_OPEN_POSITIONS: "Maximum open positions exceeded",
  MAX_SYMBOL_EXPOSURE: "Maximum symbol exposure reached",
  MAX_PORTFOLIO_EXPOSURE: "Maximum portfolio exposure reached",
  MAX_LEVERAGE: "Maximum leverage reached",
  MAX_DAILY_LOSS: "Daily loss limit exceeded",
  MAX_WEEKLY_LOSS: "Weekly loss limit exceeded",
  MAX_CONSECUTIVE_LOSSES: "Maximum consecutive losses exceeded",
  REGIME_RELIABILITY_COLLAPSE: "Regime reliability collapsed",
  MAX_OPEN_POSITION_DRAWDOWN: "Open position drawdown limit exceeded",
  REGIME_RELIABILITY_LOW: "Regime reliability is below the configured threshold",
  REGIME_BLOCKED: "Current regime is blocked",
  NEWS_SHOCK_BLOCKED: "NEWS_SHOCK blocks trading",
  LONG_NOT_ALLOWED: "Long trades are disabled",
  SHORT_NOT_ALLOWED: "Short trades are disabled",
  KILL_SWITCH_ENABLED: "Manual kill switch is enabled",
  REGIME_SIZE_BLOCKED: "Regime size multiplier blocks trading",
  POSITION_SIZE_ZERO: "Position size is zero after risk and exposure limits",
  INVALID_RISK_CONFIG: "Risk configuration contains invalid limits",
};

function addBlock(blockedBy: string[], code: string): void {
  if (!blockedBy.includes(code)) blockedBy.push(code);
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function hasValidConfig(input: RiskInput): boolean {
  const { config } = input;
  return [
    config.maxRiskPerTradePct,
    config.maxDailyLossPct,
    config.maxOpenPositions,
    config.maxSymbolExposurePct,
    config.maxPortfolioExposurePct,
    config.minRegimeReliability,
    config.defaultStopLossPct,
    config.defaultTakeProfitPct,
    config.maxLeverage,
    config.staleSignalMaxAgeMs,
    config.duplicateCooldownMs,
    config.highVolSizeMultiplier,
    config.chopSizeMultiplier,
  ].every(isFiniteNonNegative) && config.minRegimeReliability <= 1;
}

function signalSide(input: RiskInput): RiskPositionSide | null {
  if (input.signal.direction === "long") return "LONG";
  if (input.signal.direction === "short") return "SHORT";
  return null;
}

function isDuplicateInsideCooldown(input: RiskInput, side: RiskPositionSide, nowMs: number): boolean {
  if (input.config.duplicateCooldownMs <= 0) return false;
  return input.openPositions.some((position) => {
    if (position.symbol !== input.signal.symbol || position.side !== side) return false;
    const openedMs = Date.parse(position.openedAt);
    const ageMs = nowMs - openedMs;
    return Number.isFinite(openedMs) && ageMs >= 0 && ageMs <= input.config.duplicateCooldownMs;
  });
}

function passThroughDecision(input: RiskInput): RiskDecision {
  return {
    approved: true,
    reason: "Risk engine disabled; signal passed through without risk enforcement",
    sizeMultiplier: 1,
    maxRiskUsd: 0,
    positionSize: 0,
    stopLoss: input.signal.invalidationPrice ?? input.signal.stopLoss ?? null,
    takeProfit: input.signal.takeProfit ?? null,
    blockedBy: [],
    warnings: ["RISK_ENGINE_DISABLED"],
  };
}

export function evaluateRisk(input: RiskInput): RiskDecision {
  if (!input.config.enabled) return passThroughDecision(input);

  const blockedBy: string[] = [];
  const warnings: string[] = [];
  const side = signalSide(input);
  const entryPrice = input.signal.features.close;
  const nowTs = input.nowTs ?? input.signal.ts;
  const nowMs = Date.parse(nowTs);
  const signalMs = Date.parse(input.signal.ts);

  if (input.signal.signalType !== "trigger" || side === null) addBlock(blockedBy, "NO_TRADE_SIGNAL");
  if (!Number.isFinite(input.accountEquity) || input.accountEquity <= 0) addBlock(blockedBy, "ACCOUNT_EQUITY_INVALID");
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) addBlock(blockedBy, "ENTRY_PRICE_MISSING");
  if (!hasValidConfig(input)) addBlock(blockedBy, "INVALID_RISK_CONFIG");

  if (!Number.isFinite(nowMs) || !Number.isFinite(signalMs)) {
    addBlock(blockedBy, "SIGNAL_TIMESTAMP_INVALID");
  } else if (nowMs - signalMs > input.config.staleSignalMaxAgeMs) {
    addBlock(blockedBy, "SIGNAL_STALE");
  }

  if (side === "LONG" && !input.config.allowLong) addBlock(blockedBy, "LONG_NOT_ALLOWED");
  if (side === "SHORT" && !input.config.allowShort) addBlock(blockedBy, "SHORT_NOT_ALLOWED");
  if (input.openPositions.length >= input.config.maxOpenPositions) addBlock(blockedBy, "MAX_OPEN_POSITIONS");
  if (side && Number.isFinite(nowMs) && isDuplicateInsideCooldown(input, side, nowMs)) {
    addBlock(blockedBy, "DUPLICATE_COOLDOWN");
  }

  const symbolExposureUsd = input.openPositions
    .filter((position) => position.symbol === input.signal.symbol)
    .reduce((sum, position) => sum + positionNotional(position), 0);
  const portfolioExposureUsd = input.openPositions.reduce((sum, position) => sum + positionNotional(position), 0);
  if (input.accountEquity > 0) {
    if (symbolExposureUsd >= input.accountEquity * input.config.maxSymbolExposurePct) {
      addBlock(blockedBy, "MAX_SYMBOL_EXPOSURE");
    }
    if (portfolioExposureUsd >= input.accountEquity * input.config.maxPortfolioExposurePct) {
      addBlock(blockedBy, "MAX_PORTFOLIO_EXPOSURE");
    }
    if (portfolioExposureUsd >= input.accountEquity * input.config.maxLeverage) {
      addBlock(blockedBy, "MAX_LEVERAGE");
    }
  }

  if (!Number.isFinite(input.regime.reliability) || input.regime.reliability < input.config.minRegimeReliability) {
    addBlock(blockedBy, "REGIME_RELIABILITY_LOW");
  }
  if (input.config.blockedRegimes.includes(input.regime.regime)) addBlock(blockedBy, "REGIME_BLOCKED");
  if (input.regime.regime === "NEWS_SHOCK" && input.config.newsShockBlocksTrading) {
    addBlock(blockedBy, "NEWS_SHOCK_BLOCKED");
  }

  let sizeMultiplier = 1;
  if (input.regime.regime === "HIGH_VOL") {
    sizeMultiplier *= input.config.highVolSizeMultiplier;
    if (input.config.highVolSizeMultiplier < 1) warnings.push("HIGH_VOL_SIZE_REDUCED");
  }
  if (input.regime.regime === "CHOP") {
    sizeMultiplier *= input.config.chopSizeMultiplier;
    if (input.config.chopSizeMultiplier < 1) warnings.push("CHOP_SIZE_REDUCED");
  }
  sizeMultiplier = Math.min(1, Math.max(0, sizeMultiplier));
  if (sizeMultiplier <= 0) addBlock(blockedBy, "REGIME_SIZE_BLOCKED");

  const killSwitch = evaluateKillSwitch({
    accountEquity: input.accountEquity,
    openPositions: input.openPositions,
    recentPnL: input.recentPnL,
    regime: input.regime,
    config: input.config,
    nowTs,
  });
  for (const code of killSwitch.blockedBy) addBlock(blockedBy, code);

  const stopLoss = side
    ? calculateStopLoss({ signal: input.signal, side, entryPrice, config: input.config })
    : null;
  const takeProfit = side
    ? calculateTakeProfit({ signal: input.signal, side, entryPrice, config: input.config })
    : null;
  if (stopLoss === null) addBlock(blockedBy, "STOP_LOSS_MISSING");

  const baseMaxRiskUsd = input.accountEquity > 0 && input.config.maxRiskPerTradePct > 0
    ? input.accountEquity * input.config.maxRiskPerTradePct
    : 0;
  let positionSize = 0;
  let maxRiskUsd = baseMaxRiskUsd;
  if (blockedBy.length === 0 && stopLoss !== null) {
    const sizing = calculatePositionSize({
      accountEquity: input.accountEquity,
      symbol: input.signal.symbol,
      entryPrice,
      stopLoss,
      openPositions: input.openPositions,
      config: input.config,
      sizeMultiplier,
    });
    positionSize = sizing.positionSize;
    maxRiskUsd = sizing.maxRiskUsd;
    if (positionSize <= 0) addBlock(blockedBy, "POSITION_SIZE_ZERO");
  }

  const approved = blockedBy.length === 0;
  return {
    approved,
    reason: approved ? "Trade approved by deterministic risk checks" : BLOCK_REASONS[blockedBy[0]] ?? "Trade rejected",
    sizeMultiplier,
    maxRiskUsd,
    positionSize: approved ? positionSize : 0,
    stopLoss,
    takeProfit,
    blockedBy,
    warnings,
  };
}
