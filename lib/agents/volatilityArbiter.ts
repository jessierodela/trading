/**
 * lib/agents/volatilityArbiter.ts
 *
 * Volatility Arbiter Agent — GPT-4o powered.
 *
 * Pipeline (per symbol):
 *  1. Read pre-fetched ATR + candle data from indicatorCache (instant)
 *  2. Derive candle structure metrics (range, body %, close position, bar direction)
 *  3. Build structured JSON payload matching the prompt schema
 *  4. Call GPT-4o with the Volatility Arbiter system prompt
 *  5. Parse structured response → Signal[]
 *
 * The agent never fetches data. All indicator data lives in indicatorCache.ts.
 * Requires "atr" and "candle" to be enabled in config/indicators.ts for the symbol.
 *
 * Role: Execution risk interpreter. Answers whether current volatility is
 * healthy and tradeable, or unstable, late, and dangerous to chase.
 * Not a trend agent. Not a breakout trigger. Pure move quality framing.
 */

import type { Signal } from "@/lib/signals";
import type { CacheSnapshot } from "@/lib/indicatorCache";
import {
  fetchOptionalOpenAI,
  isOptionalOpenAIError,
  optionalOpenAIHttpError,
} from "@/lib/openai/config";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

// ─── GPT-4o response shape ────────────────────────────────────────────────────

interface VolatilityArbiterOutput {
  structure: {
    volatility_regime:   "compressed" | "normal" | "expanding" | "extreme";
    candle_range_state:  "small" | "normal" | "elevated" | "outsized" | "unknown";
    directional_quality: "bullish" | "bearish" | "neutral" | "chaotic" | "unknown";
    tradeability:        "tradeable" | "borderline" | "high_risk" | "unclear";
    summary: string;
  };
  volatility_conditions: {
    atr_state:                 "below_baseline" | "near_baseline" | "above_baseline" | "far_above_baseline" | "unknown";
    atr_percent_of_price_state: "low" | "moderate" | "high" | "extreme" | "unknown";
    candle_range_vs_atr:       "below_1x" | "near_1x" | "above_1x" | "above_1_5x" | "above_2x" | "unknown";
    bar_direction:             "bullish" | "bearish" | "neutral" | "unknown";
    expansion_quality:         "supportive_bullish" | "supportive_bearish" | "non_directional" | "exhaustive" | "unclear";
    chase_risk:                "low" | "moderate" | "high" | "extreme" | "unknown";
    summary: string;
  };
  implication: {
    signal:     "BUY" | "SELL" | "WATCH";
    confidence: "High" | "Moderate" | "Low";
    summary: string;
  };
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Volatility Arbiter, a market risk-framing agent specialized in evaluating ATR expansion, candle range abnormality, and directional volatility quality.

Your task is to determine whether current volatility conditions are supportive of a tradeable bullish move, a tradeable bearish move, or a high-risk / unclear environment that should be watched rather than acted on.

You must reason in exactly three sections: Structure, Volatility Conditions, Implication.

You are given precomputed market data. Use only the supplied values. Do not invent missing information.

STRUCTURE
- Determine whether current volatility is normal, expanding, or extreme relative to its recent baseline.
- Determine whether the current candle range is small, normal, elevated, or outsized relative to ATR.
- Assess whether price expansion appears directional or unstable.
- Note whether the move appears orderly and tradeable, or late and prone to reversal / chase risk.

VOLATILITY CONDITIONS
- ATR expansion is meaningful when current ATR is above its recent average or baseline.
- A candle with a range materially larger than ATR suggests unusual expansion.
- A bullish expansion is more credible when volatility expands on a bullish candle rather than a neutral or bearish one.
- A bearish expansion is more credible when volatility expands on a bearish candle rather than a neutral or bullish one.
- If volatility expands but directional quality is unclear, classify the setup as WATCH.
- If candle size is extreme relative to ATR, note elevated chase / exhaustion risk.
- Avoid overstating conviction when volatility is high but structure is chaotic.

IMPLICATION
- BUY = bullish volatility expansion is present and still appears tradeable
- SELL = bearish volatility expansion is present and still appears tradeable
- WATCH = volatility is unclear, non-directional, too extreme, or too risky to chase
- Confidence reflects clarity of volatility quality and direction.
- If evidence is mixed, choose WATCH.

STYLE: Concise, analytical, disciplined. No hype. No disclaimers. No chain-of-thought.

Return ONLY a valid JSON object — no markdown, no preamble — matching this exact schema:
{
  "structure": {
    "volatility_regime": "compressed"|"normal"|"expanding"|"extreme",
    "candle_range_state": "small"|"normal"|"elevated"|"outsized"|"unknown",
    "directional_quality": "bullish"|"bearish"|"neutral"|"chaotic"|"unknown",
    "tradeability": "tradeable"|"borderline"|"high_risk"|"unclear",
    "summary": "string"
  },
  "volatility_conditions": {
    "atr_state": "below_baseline"|"near_baseline"|"above_baseline"|"far_above_baseline"|"unknown",
    "atr_percent_of_price_state": "low"|"moderate"|"high"|"extreme"|"unknown",
    "candle_range_vs_atr": "below_1x"|"near_1x"|"above_1x"|"above_1_5x"|"above_2x"|"unknown",
    "bar_direction": "bullish"|"bearish"|"neutral"|"unknown",
    "expansion_quality": "supportive_bullish"|"supportive_bearish"|"non_directional"|"exhaustive"|"unclear",
    "chase_risk": "low"|"moderate"|"high"|"extreme"|"unknown",
    "summary": "string"
  },
  "implication": {
    "signal": "BUY"|"SELL"|"WATCH",
    "confidence": "High"|"Moderate"|"Low",
    "summary": "string"
  }
}`;

// ─── Candle structure derivation ──────────────────────────────────────────────

/**
 * Derive bar direction from open vs close.
 * Neutral threshold: body < 10% of range (doji / spinning top).
 */
function deriveBarDirection(
  open:  number,
  close: number,
  high:  number,
  low:   number
): "bullish" | "bearish" | "neutral" {
  const range = high - low;
  if (range <= 0) return "neutral";
  const bodyPct = Math.abs(close - open) / range;
  if (bodyPct < 0.1) return "neutral";
  return close >= open ? "bullish" : "bearish";
}

/**
 * Body as a fraction of total candle range (0–1).
 * High values = strong directional candle. Low values = wicky / indecisive.
 */
function deriveBodyPct(open: number, close: number, high: number, low: number): number {
  const range = high - low;
  if (range <= 0) return 0;
  return parseFloat((Math.abs(close - open) / range).toFixed(3));
}

/**
 * Where the close sits within the bar's range (0 = at low, 1 = at high).
 * High values on bullish bars = strong close. Low values = faded / weak.
 */
function deriveClosePosition(close: number, high: number, low: number): number {
  const range = high - low;
  if (range <= 0) return 0.5;
  return parseFloat(((close - low) / range).toFixed(3));
}

// ─── Main agent function ──────────────────────────────────────────────────────

/**
 * Run Volatility Arbiter on all symbols that have ATR + candle data in the cache.
 * Skips symbols missing atr, high, or low (not enabled in indicators config).
 */
export async function runVolatilityArbiter(
  snapshot:  CacheSnapshot,
  timeframe: string = "1h"
): Promise<Signal[]> {
  const results: Signal[] = [];

  for (const [symbol, data] of snapshot.data.entries()) {
    const { indicators } = data;

    // Requires ATR and candle OHLC — skip if not enabled for this symbol
    if (
      indicators.atr  == null ||
      indicators.high == null ||
      indicators.low  == null
    ) continue;

    const atr          = indicators.atr;
    const high         = indicators.high;
    const low          = indicators.low;
    const close        = indicators.currentClose ?? null;
    const atr_avg_20   = indicators.atrAvg20 ?? atr; // fallback to current ATR if baseline unavailable

    if (close === null) {
      console.warn(`[volatilityArbiter] ${symbol} — skipping, currentClose is null`);
      continue;
    }

    // close is narrowed to number here — safe to use as open fallback
    const open = indicators.open ?? close; // fallback to close (doji) if candle open unavailable

    // Derived candle structure
    const candle_range         = parseFloat((high - low).toFixed(4));
    const candle_range_vs_atr  = atr > 0 ? parseFloat((candle_range / atr).toFixed(3)) : 0;
    const bar_direction        = deriveBarDirection(open, close, high, low);
    const body_pct_of_range    = deriveBodyPct(open, close, high, low);
    const close_position       = deriveClosePosition(close, high, low);
    const atr_pct_of_price     = close > 0 ? parseFloat((atr / close).toFixed(5)) : 0;

    const relativeVolume = indicators.volumeSma20 && indicators.volume
      ? parseFloat((indicators.volume / indicators.volumeSma20).toFixed(2))
      : null;

    const payload = {
      agent:      "volatility_arbiter",
      symbol,
      timeframe,
      indicators: {
        close,
        open,
        high,
        low,
        atr,
        atr_avg_20,
        atr_pct_of_price,
        candle_range,
        candle_range_vs_atr,
        bar_direction,
        body_pct_of_range,
        close_position_in_bar: close_position,
        relative_volume:       relativeVolume ?? 1.0,
      },
    };

    try {
      const res = await fetchOptionalOpenAI(`volatilityArbiter:${symbol}`, OPENAI_API_URL, {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model:       "gpt-4o",
          temperature: 0,
          max_tokens:  600,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user",   content: `Analyze this volatility setup:\n${JSON.stringify(payload, null, 2)}` },
          ],
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        const optionalErr = optionalOpenAIHttpError("volatilityArbiter", res.status, errText);
        if (optionalErr) throw optionalErr;
        console.error(`[volatilityArbiter] OpenAI error for ${symbol}: ${res.status} — ${errText}`);
        continue;
      }

      const json  = await res.json();
      const raw   = json.choices?.[0]?.message?.content ?? "";
      const clean = raw.replace(/```json|```/g, "").trim();
      const result: VolatilityArbiterOutput = JSON.parse(clean);

      const { implication, structure, volatility_conditions } = result;

      const signal: Signal = {
        agent:      "Volatility Arbiter",
        symbol,
        type:       implication.signal === "BUY"  ? "buy"
                  : implication.signal === "SELL" ? "sell"
                  : "watch",
        confidence: implication.confidence === "High"     ? "high"
                  : implication.confidence === "Moderate" ? "medium"
                  : "low",
        reason: [
          `[${implication.signal}] ${implication.summary}`,
          `Structure: ${structure.summary}`,
          `Volatility: ${volatility_conditions.summary}`,
          `Regime: ${structure.volatility_regime} | Chase risk: ${volatility_conditions.chase_risk}`,
        ].join(" — "),
        tags: [structure.volatility_regime as any],
        context: {
          ema20PctDistance: undefined, // not relevant for this agent
        },
      };

      results.push(signal);
    } catch (err) {
      if (isOptionalOpenAIError(err)) throw err;
      if (err instanceof TypeError) {
        throw err;
      }
      console.error(`[volatilityArbiter] GPT-4o error for ${symbol}:`, err);
      // Skip this symbol — don't crash the whole agent run
    }
  }

  return results;
}
