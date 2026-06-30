import type { FeatureSnapshot, RegimeLabel } from "@/lib/quant/types";

export type DeterministicRegimeLabel =
  | RegimeLabel
  | "RANGE"
  | "UNKNOWN";

export interface DeterministicRegimeInput {
  symbol: string;
  timestamp: string;
  source?: string;
  close?: number | null;
  rsi14?: number | null;
  macdHist?: number | null;
  ema20?: number | null;
  ema20Slope?: number | null;
  ema50?: number | null;
  ema200?: number | null;
  ema50Slope?: number | null;
  ema200Slope?: number | null;
  atrPct?: number | null;
  bbWidth?: number | null;
  bbWidthPrev?: number | null;
  relativeVolume20?: number | null;
  candleRangeAtr?: number | null;
  dailyEma50AboveEma200?: boolean | null;
  dailyPriceAboveEma200?: boolean | null;
}

export interface DeterministicRegimeResult {
  regime: DeterministicRegimeLabel;
  confidence: number;
  reason: string;
  inputsUsed: string[];
  timestamp: string;
  symbol: string;
  source?: string;
  aiUsed: false;
}

export interface PersistableRegimeResult {
  regime: RegimeLabel;
  reliability: number;
  reason: string;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function addInput(inputsUsed: string[], name: string, value: unknown): void {
  if (value !== null && value !== undefined) inputsUsed.push(name);
}

export function classifyDeterministicRegime(input: DeterministicRegimeInput): DeterministicRegimeResult {
  const inputsUsed: string[] = [];
  addInput(inputsUsed, "close", input.close);
  addInput(inputsUsed, "rsi14", input.rsi14);
  addInput(inputsUsed, "macdHist", input.macdHist);
  addInput(inputsUsed, "ema20", input.ema20);
  addInput(inputsUsed, "ema20Slope", input.ema20Slope);
  addInput(inputsUsed, "ema50", input.ema50);
  addInput(inputsUsed, "ema200", input.ema200);
  addInput(inputsUsed, "ema50Slope", input.ema50Slope);
  addInput(inputsUsed, "ema200Slope", input.ema200Slope);
  addInput(inputsUsed, "atrPct", input.atrPct);
  addInput(inputsUsed, "bbWidth", input.bbWidth);
  addInput(inputsUsed, "bbWidthPrev", input.bbWidthPrev);
  addInput(inputsUsed, "relativeVolume20", input.relativeVolume20);
  addInput(inputsUsed, "candleRangeAtr", input.candleRangeAtr);
  addInput(inputsUsed, "dailyEma50AboveEma200", input.dailyEma50AboveEma200);
  addInput(inputsUsed, "dailyPriceAboveEma200", input.dailyPriceAboveEma200);

  if (!Number.isFinite(Date.parse(input.timestamp)) || !finite(input.close) || input.close <= 0) {
    return {
      regime: "UNKNOWN",
      confidence: 0.1,
      reason: "insufficient_data: missing valid timestamp or close",
      inputsUsed,
      timestamp: input.timestamp,
      symbol: input.symbol,
      source: input.source,
      aiUsed: false,
    };
  }

  let trendUpScore = 0;
  let trendDownScore = 0;

  if (finite(input.ema20)) {
    if (input.close > input.ema20) trendUpScore++;
    if (input.close < input.ema20) trendDownScore++;
  }
  if (finite(input.ema20Slope)) {
    if (input.ema20Slope > 0) trendUpScore++;
    if (input.ema20Slope < 0) trendDownScore++;
  }
  if (finite(input.ema50) && finite(input.ema200)) {
    if (input.ema50 > input.ema200) trendUpScore++;
    if (input.ema50 < input.ema200) trendDownScore++;
  } else if (input.dailyEma50AboveEma200 === true) {
    trendUpScore++;
  } else if (input.dailyEma50AboveEma200 === false) {
    trendDownScore++;
  }
  if (input.dailyPriceAboveEma200 === true) trendUpScore++;
  if (input.dailyPriceAboveEma200 === false) trendDownScore++;
  if (finite(input.rsi14)) {
    if (input.rsi14 >= 52 && input.rsi14 <= 75) trendUpScore++;
    if (input.rsi14 <= 48) trendDownScore++;
  }
  if (finite(input.macdHist)) {
    if (input.macdHist > 0) trendUpScore++;
    if (input.macdHist < 0) trendDownScore++;
  }

  const trendDelta = Math.abs(trendUpScore - trendDownScore);
  const trendDominant = trendDelta >= 2 && Math.max(trendUpScore, trendDownScore) >= 3;
  const volatilityElevated =
    (finite(input.atrPct) && input.atrPct >= 2.5) ||
    (finite(input.candleRangeAtr) && input.candleRangeAtr >= 1.8) ||
    (finite(input.relativeVolume20) && input.relativeVolume20 >= 2.2);
  const volatilityCompressed =
    (finite(input.atrPct) && input.atrPct <= 0.8) ||
    (
      finite(input.bbWidth) &&
      finite(input.bbWidthPrev) &&
      input.bbWidth < input.bbWidthPrev * 0.8
    );

  if (trendDominant && trendUpScore > trendDownScore) {
    return {
      regime: "TREND_UP",
      confidence: clamp01(0.55 + trendDelta * 0.1),
      reason: `deterministic_trend_up: upScore=${trendUpScore}, downScore=${trendDownScore}`,
      inputsUsed,
      timestamp: input.timestamp,
      symbol: input.symbol,
      source: input.source,
      aiUsed: false,
    };
  }

  if (trendDominant && trendDownScore > trendUpScore) {
    return {
      regime: "TREND_DOWN",
      confidence: clamp01(0.55 + trendDelta * 0.1),
      reason: `deterministic_trend_down: upScore=${trendUpScore}, downScore=${trendDownScore}`,
      inputsUsed,
      timestamp: input.timestamp,
      symbol: input.symbol,
      source: input.source,
      aiUsed: false,
    };
  }

  if (volatilityElevated) {
    return {
      regime: "HIGH_VOL",
      confidence: 0.7,
      reason: "deterministic_high_vol: volatility elevated without dominant trend",
      inputsUsed,
      timestamp: input.timestamp,
      symbol: input.symbol,
      source: input.source,
      aiUsed: false,
    };
  }

  if (volatilityCompressed) {
    return {
      regime: "LOW_VOL",
      confidence: 0.65,
      reason: "deterministic_low_vol: volatility compressed without dominant trend",
      inputsUsed,
      timestamp: input.timestamp,
      symbol: input.symbol,
      source: input.source,
      aiUsed: false,
    };
  }

  if (inputsUsed.length < 4) {
    return {
      regime: "UNKNOWN",
      confidence: 0.2,
      reason: "insufficient_data: fewer than four usable persisted inputs",
      inputsUsed,
      timestamp: input.timestamp,
      symbol: input.symbol,
      source: input.source,
      aiUsed: false,
    };
  }

  return {
    regime: "RANGE",
    confidence: 0.55,
    reason: `deterministic_range: no dominant trend or volatility condition (upScore=${trendUpScore}, downScore=${trendDownScore})`,
    inputsUsed,
    timestamp: input.timestamp,
    symbol: input.symbol,
    source: input.source,
    aiUsed: false,
  };
}

export function featureSnapshotsToRegimeInput(
  feature1h: FeatureSnapshot | null,
  feature1d: FeatureSnapshot | null,
  fallback: { symbol: string; timestamp: string; source?: string },
): DeterministicRegimeInput {
  return {
    symbol: feature1h?.symbol ?? fallback.symbol,
    timestamp: feature1h?.ts ?? fallback.timestamp,
    source: fallback.source ?? "persisted_feature_snapshots",
    close: feature1h?.close ?? null,
    rsi14: feature1h?.rsi14 ?? null,
    macdHist: feature1h?.macdHist ?? null,
    ema20: feature1h?.ema20 ?? null,
    ema20Slope: feature1h?.ema20Slope ?? null,
    ema50: feature1h?.ema50 ?? feature1d?.ema50 ?? null,
    ema200: feature1h?.ema200 ?? feature1d?.ema200 ?? null,
    ema50Slope: feature1h?.ema50Slope ?? feature1d?.ema50Slope ?? null,
    ema200Slope: feature1h?.ema200Slope ?? feature1d?.ema200Slope ?? null,
    atrPct: feature1h?.atrPct ?? null,
    bbWidth: feature1h?.bbWidth ?? null,
    bbWidthPrev: feature1h?.bbWidthPrev ?? null,
    relativeVolume20: feature1h?.relativeVolume20 ?? null,
    candleRangeAtr: feature1h?.candleRangeAtr ?? null,
    dailyEma50AboveEma200: feature1h?.daily_ema50AboveEma200 ?? (
      feature1d?.ema50 != null && feature1d?.ema200 != null ? feature1d.ema50 > feature1d.ema200 : null
    ),
    dailyPriceAboveEma200: feature1h?.daily_priceAboveEma200 ?? (
      feature1d?.close != null && feature1d?.ema200 != null ? feature1d.close > feature1d.ema200 : null
    ),
  };
}

export function classifyFeatureRegime(
  feature1h: FeatureSnapshot | null,
  feature1d: FeatureSnapshot | null,
  fallback: { symbol: string; timestamp: string; source?: string },
): DeterministicRegimeResult {
  return classifyDeterministicRegime(featureSnapshotsToRegimeInput(feature1h, feature1d, fallback));
}

export function toPersistableRegime(result: DeterministicRegimeResult): PersistableRegimeResult {
  if (result.regime === "RANGE") {
    return {
      regime: "CHOP",
      reliability: result.confidence,
      reason: `${result.reason}; persisted_as=CHOP`,
    };
  }
  if (result.regime === "UNKNOWN") {
    return {
      regime: "CHOP",
      reliability: Math.min(result.confidence, 0.25),
      reason: `${result.reason}; persisted_as=CHOP_safe_unknown`,
    };
  }
  return {
    regime: result.regime,
    reliability: result.confidence,
    reason: result.reason,
  };
}
