import type { Position, RiskConfig } from "./types";

export interface PositionSizingInput {
  accountEquity: number;
  symbol: string;
  entryPrice: number;
  stopLoss: number;
  openPositions: Position[];
  config: RiskConfig;
  sizeMultiplier: number;
}

export interface PositionSizingResult {
  maxRiskUsd: number;
  riskPerUnit: number;
  rawPositionSize: number;
  positionSize: number;
  symbolExposureUsd: number;
  portfolioExposureUsd: number;
  maxPositionNotionalUsd: number;
}

export function positionNotional(position: Position): number {
  if (!Number.isFinite(position.quantity) || !Number.isFinite(position.markPrice)) return 0;
  return Math.abs(position.quantity * position.markPrice);
}

export function calculatePositionSize(input: PositionSizingInput): PositionSizingResult {
  const { accountEquity, symbol, entryPrice, stopLoss, openPositions, config } = input;
  const symbolExposureUsd = openPositions
    .filter((position) => position.symbol === symbol)
    .reduce((sum, position) => sum + positionNotional(position), 0);
  const portfolioExposureUsd = openPositions.reduce((sum, position) => sum + positionNotional(position), 0);
  const maxRiskUsd = Number.isFinite(accountEquity) && accountEquity > 0 && config.maxRiskPerTradePct > 0
    ? accountEquity * config.maxRiskPerTradePct
    : 0;
  const riskPerUnit = Math.abs(entryPrice - stopLoss);
  const rawPositionSize = maxRiskUsd > 0 && Number.isFinite(riskPerUnit) && riskPerUnit > 0
    ? maxRiskUsd / riskPerUnit
    : 0;

  const symbolLimitUsd = Math.max(0, accountEquity * config.maxSymbolExposurePct);
  const portfolioLimitUsd = Math.max(0, accountEquity * config.maxPortfolioExposurePct);
  const leverageLimitUsd = Math.max(0, accountEquity * config.maxLeverage);
  const remainingSymbolUsd = Math.max(0, symbolLimitUsd - symbolExposureUsd);
  const remainingPortfolioUsd = Math.max(0, portfolioLimitUsd - portfolioExposureUsd);
  const remainingLeverageUsd = Math.max(0, leverageLimitUsd - portfolioExposureUsd);
  const maxPositionNotionalUsd = Math.min(remainingSymbolUsd, remainingPortfolioUsd, remainingLeverageUsd);
  const exposureCappedSize = Number.isFinite(entryPrice) && entryPrice > 0
    ? maxPositionNotionalUsd / entryPrice
    : 0;
  const sizeMultiplier = Number.isFinite(input.sizeMultiplier)
    ? Math.min(1, Math.max(0, input.sizeMultiplier))
    : 0;
  const positionSize = Math.max(0, Math.min(rawPositionSize * sizeMultiplier, exposureCappedSize));

  return {
    maxRiskUsd,
    riskPerUnit,
    rawPositionSize,
    positionSize: Number.isFinite(positionSize) ? positionSize : 0,
    symbolExposureUsd,
    portfolioExposureUsd,
    maxPositionNotionalUsd,
  };
}
