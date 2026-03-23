/**
 * lib/agents/meanReversion.ts
 *
 * Mean Reversion Agent — detects short-term oversold bounce setups.
 *
 * Architecture note (matches existing agents):
 *  - Accepts a pre-fetched IndicatorCacheSnapshot — never fetches its own data.
 *  - Returns a Signal[] that integrates directly into the AgentResult / refresh pipeline.
 *  - Threshold classification is deterministic (hard rules) before GPT reasoning.
 *  - GPT-4o provides the structured narrative; enums are enforced post-response.
 */

import OpenAI from "openai";
import type { IndicatorCacheSnapshot } from "@/lib/indicatorCache";
import type { Signal } from "@/lib/signals";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Internal types ────────────────────────────────────────────────────────────

type RsiState       = "not_oversold" | "mildly_oversold" | "oversold" | "deeply_oversold";
type HistogramState = "worsening" | "flat" | "improving" | "positive_turn";
type EmaState       = "near_mean" | "moderately_extended_below" | "deeply_extended_below";
type MRSignal       = "BUY" | "WATCH" | "NEUTRAL";
type Confidence     = "high" | "medium" | "low";

interface ThresholdStates {
  rsi_state:            RsiState;
  macd_histogram_state: HistogramState;
  price_vs_ema20_state: EmaState;
}

interface MeanReversionOutput {
  agent:      "mean_reversion";
  symbol:     string;
  timestamp:  string;
  timeframe:  "1h";
  signal:     MRSignal;
  confidence: Confidence;
  summary:    string;
  structure: {
    oversold_condition: string;
    histogram_turning:  string;
    mean_distance:      string;
  };
  thresholds:  ThresholdStates;
  inputs_used: {
    rsi:                         number | null;
    macd_histogram:              number | null;
    macd_histogram_prev:         number | null;
    ema20:                       number | null;
    price:                       number | null;
    price_distance_from_ema20_pct: number | null;
  };
  notes: string;
}

// ─── Hard-rule threshold classifier ───────────────────────────────────────────
// Runs before GPT. Results are passed as context and enforced on the response,
// so deterministic enum values can never be overridden by the model.

function classifyThresholds(
  rsi:                       number | null,
  macd_histogram:            number | null,
  macd_histogram_prev:       number | null,
  price_distance_from_ema20: number | null
): ThresholdStates {
  // RSI state
  let rsi_state: RsiState = "not_oversold";
  if (rsi !== null) {
    if (rsi < 25)       rsi_state = "deeply_oversold";
    else if (rsi < 30)  rsi_state = "oversold";
    else if (rsi < 35)  rsi_state = "mildly_oversold";
  }

  // MACD histogram direction
  let macd_histogram_state: HistogramState = "flat";
  if (macd_histogram !== null && macd_histogram_prev !== null) {
    const delta = macd_histogram - macd_histogram_prev;
    if (macd_histogram > 0 && macd_histogram_prev <= 0) {
      macd_histogram_state = "positive_turn";
    } else if (delta > 0.02) {
      macd_histogram_state = "improving";
    } else if (delta < -0.02) {
      macd_histogram_state = "worsening";
    }
    // else: flat
  }

  // Price vs EMA20 stretch
  let price_vs_ema20_state: EmaState = "near_mean";
  if (price_distance_from_ema20 !== null) {
    if (price_distance_from_ema20 < -3.0)      price_vs_ema20_state = "deeply_extended_below";
    else if (price_distance_from_ema20 < -1.0) price_vs_ema20_state = "moderately_extended_below";
  }

  return { rsi_state, macd_histogram_state, price_vs_ema20_state };
}

// ─── Fast eligibility gate ─────────────────────────────────────────────────────
// Skip GPT entirely when conditions obviously don't meet the minimum bar.
// Saves tokens and keeps the pipeline fast for non-oversold symbols.

function isEligible(thresholds: ThresholdStates): boolean {
  const { rsi_state, macd_histogram_state } = thresholds;

  // Must be at least mildly oversold
  if (rsi_state === "not_oversold") return false;

  // Histogram must not still be aggressively worsening when RSI is only mildly oversold
  if (rsi_state === "mildly_oversold" && macd_histogram_state === "worsening") return false;

  return true;
}

// ─── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Mean Reversion, a short-horizon oversold bounce detection agent.

Your role is to evaluate whether current conditions suggest a high-probability mean reversion setup after an aggressive downside extension. You are not a long-term trend reversal model — do not predict macro bottoms. Identify reflex bounce conditions caused by short-term oversold exhaustion only.

Use only the supplied data. Do not invent missing values. If data is incomplete or conflicting, lower confidence and explain why in notes.

Reasoning sequence:

1. Oversold condition — RSI below 30 is meaningful; below 25 is extreme. State the severity.
2. Histogram turning — Is bearish momentum fading (less negative) or still accelerating (more negative)? A positive_turn is strongest; improving is sufficient for BUY consideration.
3. Mean distance — How far is price stretched below EMA20? Larger stretch increases bounce probability but also downside risk if the trend is strongly bearish.
4. Signal synthesis — Combine all three factors:
   - BUY: RSI deeply oversold + histogram improving/positive_turn + meaningful EMA20 stretch
   - WATCH: Oversold but histogram not yet confirming, or stretch is moderate
   - NEUTRAL: Not sufficiently oversold, or momentum still worsening aggressively

Confidence:
- High: strong agreement across all three factors
- Medium: partial alignment or mild contradiction
- Low: weak data, incomplete inputs, or conflicting evidence

Keep rationale concise and tactical. No long-term investing language.

Return ONLY valid JSON — no markdown, no preamble:
{
  "agent": "mean_reversion",
  "symbol": string,
  "timestamp": string,
  "timeframe": "1h",
  "signal": "BUY" | "WATCH" | "NEUTRAL",
  "confidence": "high" | "medium" | "low",
  "summary": string,
  "structure": {
    "oversold_condition": string,
    "histogram_turning": string,
    "mean_distance": string
  },
  "thresholds": {
    "rsi_state": "not_oversold" | "mildly_oversold" | "oversold" | "deeply_oversold",
    "macd_histogram_state": "worsening" | "flat" | "improving" | "positive_turn",
    "price_vs_ema20_state": "near_mean" | "moderately_extended_below" | "deeply_extended_below"
  },
  "inputs_used": {
    "rsi": number | null,
    "macd_histogram": number | null,
    "macd_histogram_prev": number | null,
    "ema20": number | null,
    "price": number | null,
    "price_distance_from_ema20_pct": number | null
  },
  "notes": string
}`;

// ─── Single-symbol runner ──────────────────────────────────────────────────────

async function runMeanReversionForSymbol(
  symbol:    string,
  timestamp: string,
  rsi:                           number | null,
  macd_histogram:                number | null,
  macd_histogram_prev:           number | null,
  ema20:                         number | null,
  price:                         number | null,
  // Pre-computed by indicatorCache.ts — ((currentClose - ema20) / ema20) * 100
  // Using the cached value keeps this consistent with what other agents see.
  price_distance_from_ema20_pct: number | null,
): Promise<MeanReversionOutput | null> {

  const thresholds = classifyThresholds(rsi, macd_histogram, macd_histogram_prev, price_distance_from_ema20_pct);

  // Fast-exit: skip GPT for clearly ineligible symbols
  if (!isEligible(thresholds)) return null;

  const userMessage = `
Analyze this symbol for a mean reversion bounce setup.

Pipeline input:
${JSON.stringify({
    symbol,
    timeframe: "1h",
    timestamp,
    rsi,
    macd_histogram,
    macd_histogram_prev,
    ema20,
    price,
    price_distance_from_ema20_pct,
  }, null, 2)}

Pre-classified threshold states (use as your thresholds output):
${JSON.stringify(thresholds, null, 2)}

Return structured JSON only.`.trim();

  const completion = await openai.chat.completions.create({
    model:           "gpt-4o",
    temperature:     0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: userMessage },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error(`[mean-reversion] Empty GPT response for ${symbol}`);

  const parsed: MeanReversionOutput = JSON.parse(raw);

  // Enforce deterministic fields — GPT cannot override these
  parsed.agent      = "mean_reversion";
  parsed.thresholds = thresholds;

  return parsed;
}

// ─── Signal converter ──────────────────────────────────────────────────────────
// Maps MeanReversionOutput → Signal so the refresh pipeline can treat it
// identically to signals from other agents.

function toSignal(output: MeanReversionOutput): Signal {
  const confidenceMap: Record<Confidence, Signal["confidence"]> = {
    high:   "high",
    medium: "medium",
    low:    "low",
  };

  const typeMap: Record<MRSignal, Signal["type"]> = {
    BUY:     "buy",
    WATCH:   "watch",
    NEUTRAL: "neutral",
  };

  return {
    symbol:     output.symbol,
    type:       typeMap[output.signal],
    confidence: confidenceMap[output.confidence],
    reason:     output.summary,
    agent:      "Mean Reversion",
    timestamp:  output.timestamp,
    // Pass through the full structured output for the detail panel
    meta: {
      structure:   output.structure,
      thresholds:  output.thresholds,
      inputs_used: output.inputs_used,
      notes:       output.notes,
    },
  };
}

// ─── Public entry point ────────────────────────────────────────────────────────

export async function runMeanReversion(
  snapshot: IndicatorCacheSnapshot
): Promise<Signal[]> {
  const timestamp = new Date().toISOString();
  const symbols   = [...snapshot.data.keys()];

  // Run all eligible symbols concurrently — GPT calls are I/O-bound
  const settled = await Promise.allSettled(
    symbols.map((symbol) => {
      const entry = snapshot.data.get(symbol);
      if (!entry) return Promise.resolve(null);

      const { indicators, derived } = entry;

      // ── Field mapping — indicatorCache.ts shape ──────────────────────────
      // indicators.macd is the full MACD object; histogram lives at .valueMACDHist
      // indicators.prevHist is the previous-bar histogram value (set by taapi.ts)
      // indicators.currentClose is the yahoo-finance2-overridden close price
      // derived.ema20PctDist is pre-computed ((close - ema20) / ema20) * 100
      const macd_histogram      = indicators.macd?.valueMACDHist ?? null;
      const macd_histogram_prev = indicators.prevHist             ?? null;
      const price               = indicators.currentClose         ?? null;

      return runMeanReversionForSymbol(
        symbol,
        timestamp,
        indicators.rsi  ?? null,
        macd_histogram,
        macd_histogram_prev,
        indicators.ema20 ?? null,
        price,
        // Pass pre-computed distance so the agent doesn't recompute from
        // a potentially stale price — derived was computed with the same
        // yahoo-finance2-overridden close that agents use.
        derived.ema20PctDist ?? null,
      );
    })
  );

  const signals: Signal[] = [];

  settled.forEach((result, i) => {
    if (result.status === "rejected") {
      console.warn(`[mean-reversion] ${symbols[i]} failed:`, result.reason);
      return;
    }
    const output = result.value;
    if (!output || output.signal === "NEUTRAL") return;
    signals.push(toSignal(output));
  });

  return signals;
}
