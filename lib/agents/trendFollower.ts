/**
 * lib/agents/trendFollower.ts
 *
 * Trend Follower Agent — GPT-4o powered.
 *
 * Pipeline (per symbol):
 *  1. Read pre-fetched EMA50 + EMA200 data from indicatorCache1d (instant)
 *  2. Build structured JSON payload matching the prompt schema
 *  3. Call GPT-4o with the Trend Follower system prompt + JSON schema enforcement
 *  4. Parse structured response → Signal[]
 *
 * The agent never fetches data. All indicator data lives in indicatorCache1d.ts.
 * Requires "ema50" and "ema200" to be enabled in config/indicators1d.ts for the symbol.
 *
 * Role: Structural bias layer. Evaluates EMA50/200 context on 1D bars — the
 * intended timeframe for golden/death cross and trend regime classification.
 * Output consumed as directional backdrop by Momentum Scout and Breakout Watcher.
 */

import type { Signal } from "@/lib/signals";
import type { CacheSnapshot1d } from "@/lib/indicatorCache1d";
import {
  isOptionalOpenAIError,
  OptionalOpenAIError,
  optionalOpenAIHttpError,
} from "@/lib/openai/config";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

// ─── GPT-4o response shape ────────────────────────────────────────────────────

interface TrendFollowerOutput {
  structure: {
    price_location:
      | "above_both_emas"
      | "below_both_emas"
      | "between_emas"
      | "at_ema50"
      | "at_ema200"
      | "unknown";
    ema_alignment:
      | "ema50_above_ema200"
      | "ema50_below_ema200"
      | "ema50_crossing_above_ema200"
      | "ema50_crossing_below_ema200"
      | "compressed_or_flat"
      | "unknown";
    trend_regime: "bullish" | "bearish" | "mixed" | "transitional";
    price_alignment_with_structure:
      | "aligned_bullish"
      | "aligned_bearish"
      | "conflicted"
      | "neutral";
    summary: string;
  };
  trend_conditions: {
    golden_cross_present: boolean;
    death_cross_present: boolean;
    price_vs_ema50: "above" | "below" | "at" | "unknown";
    price_vs_ema200: "above" | "below" | "at" | "unknown";
    trend_strength: "strong" | "moderate" | "weak" | "unclear";
    transition_risk: "low" | "moderate" | "high" | "unknown";
    summary: string;
  };
  implication: {
    signal: "BUY" | "SELL" | "WATCH";
    confidence: "High" | "Moderate" | "Low";
    summary: string;
  };
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Trend Follower, a market structure agent specialized in evaluating higher-timeframe trend context using the 50-period EMA, 200-period EMA, and price location relative to both.

Your task is to determine whether the current market structure is bullish, bearish, or mixed. You are not a trigger agent. You do not predict short-term moves. You define the broader directional backdrop that other agents use as context.

You must reason in exactly three sections: Structure, Trend Conditions, Implication.

You are given precomputed market data. Use only the supplied values. Do not invent missing information.

STRUCTURE
- Determine whether price is above both EMAs, below both EMAs, between them, or interacting with one.
- Determine whether EMA50 is above EMA200, below EMA200, or crossing.
- Assess whether the market is structurally bullish, bearish, or mixed / transitional.
- Note whether price and EMA alignment agree or conflict.

TREND CONDITIONS
- Bullish structure is strongest when price is above EMA50 and EMA200, and EMA50 is above EMA200.
- Bearish structure is strongest when price is below EMA50 and EMA200, and EMA50 is below EMA200.
- Mixed structure occurs when price is between the EMAs, conflicts with EMA alignment, or when averages are compressing / crossing.
- A golden cross (EMA50 crossed above EMA200 recently) strengthens long-term bullish context.
- A death cross (EMA50 crossed below EMA200 recently) strengthens long-term bearish context.
- Avoid overstating conviction if price is only marginally above or below the EMAs.
- If transitioning, clearly state that trend context is not fully confirmed.

IMPLICATION
- BUY = bullish trend context supports long exposure
- SELL = bearish trend context supports short exposure
- WATCH = mixed, transitional, or low-conviction trend context
- Confidence reflects clarity of alignment, not excitement.
- If evidence is mixed, choose WATCH.

STYLE: Concise, analytical, disciplined. No hype. No disclaimers. No chain-of-thought.

Return ONLY a valid JSON object — no markdown, no preamble — matching this exact schema:
{
  "structure": {
    "price_location": "above_both_emas"|"below_both_emas"|"between_emas"|"at_ema50"|"at_ema200"|"unknown",
    "ema_alignment": "ema50_above_ema200"|"ema50_below_ema200"|"ema50_crossing_above_ema200"|"ema50_crossing_below_ema200"|"compressed_or_flat"|"unknown",
    "trend_regime": "bullish"|"bearish"|"mixed"|"transitional",
    "price_alignment_with_structure": "aligned_bullish"|"aligned_bearish"|"conflicted"|"neutral",
    "summary": "string"
  },
  "trend_conditions": {
    "golden_cross_present": boolean,
    "death_cross_present": boolean,
    "price_vs_ema50": "above"|"below"|"at"|"unknown",
    "price_vs_ema200": "above"|"below"|"at"|"unknown",
    "trend_strength": "strong"|"moderate"|"weak"|"unclear",
    "transition_risk": "low"|"moderate"|"high"|"unknown",
    "summary": "string"
  },
  "implication": {
    "signal": "BUY"|"SELL"|"WATCH",
    "confidence": "High"|"Moderate"|"Low",
    "summary": "string"
  }
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive the EMA cross state from current + prior bar values.
 * "fresh" = crossed on this bar. "active" = already crossed, still holding.
 */
function deriveCrossState(
  ema50:     number,
  ema200:    number,
  prevEma50:  number | null,
  prevEma200: number | null
): "golden_cross_fresh" | "death_cross_fresh" | "golden_cross_active" | "death_cross_active" | "none" {
  const currentAbove = ema50 > ema200;

  if (prevEma50 !== null && prevEma200 !== null) {
    const prevAbove = prevEma50 > prevEma200;
    if (!prevAbove && currentAbove) return "golden_cross_fresh";
    if (prevAbove && !currentAbove) return "death_cross_fresh";
  }

  return currentAbove ? "golden_cross_active" : "death_cross_active";
}

/**
 * Derive slope direction from current vs prior bar value.
 * 0.02% threshold avoids noise on flat markets.
 */
function deriveSlope(current: number, prev: number | null): "up" | "down" | "flat" {
  if (prev === null) return "flat";
  const delta = (current - prev) / prev;
  if (delta >  0.0002) return "up";
  if (delta < -0.0002) return "down";
  return "flat";
}

// ─── Main agent function ──────────────────────────────────────────────────────

/**
 * Run Trend Follower on all symbols that have EMA50 + EMA200 in the cache.
 * Skips symbols where either EMA is null (not enabled in indicators config).
 */
export async function runTrendFollower(
  snapshot:  CacheSnapshot1d,
  timeframe: string = "1d"
): Promise<Signal[]> {
  const results: Signal[] = [];

  for (const [symbol, data] of snapshot.data.entries()) {
    const { indicators } = data;

    // Requires both EMAs — skip if not enabled for this symbol
    if (indicators.ema50 == null || indicators.ema200 == null) continue;

    const ema50      = indicators.ema50;
    const ema200     = indicators.ema200;
    const close      = indicators.currentClose ?? null;
    const prevEma50  = indicators.prevEma50  ?? null;
    const prevEma200 = indicators.prevEma200 ?? null;

    if (close === null) {
      console.warn(`[trendFollower] ${symbol} — skipping, currentClose is null`);
      continue;
    }

    const crossState  = deriveCrossState(ema50, ema200, prevEma50, prevEma200);
    const ema50Slope  = deriveSlope(ema50,  prevEma50);
    const ema200Slope = deriveSlope(ema200, prevEma200);

    const distanceToEma50  = ema50  > 0 ? (close - ema50)  / ema50  : 0;
    const distanceToEma200 = ema200 > 0 ? (close - ema200) / ema200 : 0;
    const emaSpreadPct     = ema200 > 0 ? (ema50  - ema200) / ema200 : 0;

    const payload = {
      agent:      "trend_follower",
      symbol,
      timeframe,
      indicators: {
        close,
        ema50,
        ema200,
        prior_ema50:            prevEma50,
        prior_ema200:           prevEma200,
        distance_pct_to_ema50:  parseFloat(distanceToEma50.toFixed(4)),
        distance_pct_to_ema200: parseFloat(distanceToEma200.toFixed(4)),
        ema_spread_pct:         parseFloat(emaSpreadPct.toFixed(4)),
        ema50_slope:            ema50Slope,
        ema200_slope:           ema200Slope,
        cross_state:            crossState,
      },
    };

    try {
      const res = await fetch(OPENAI_API_URL, {
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
            { role: "user",   content: `Analyze this trend structure:\n${JSON.stringify(payload, null, 2)}` },
          ],
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        const optionalErr = optionalOpenAIHttpError("trendFollower", res.status, errText);
        if (optionalErr) throw optionalErr;
        console.error(`[trendFollower] OpenAI error for ${symbol}: ${res.status} — ${errText}`);
        continue;
      }

      const json  = await res.json();
      const raw   = json.choices?.[0]?.message?.content ?? "";
      const clean = raw.replace(/```json|```/g, "").trim();
      const result: TrendFollowerOutput = JSON.parse(clean);

      const { implication, structure, trend_conditions } = result;

      const signal: Signal = {
        agent:      "Trend Follower",
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
          `Conditions: ${trend_conditions.summary}`,
          `Regime: ${structure.trend_regime} | Transition risk: ${trend_conditions.transition_risk}`,
        ].join(" — "),
        tags: [structure.trend_regime as any],
        context: {
          ema20PctDistance: ema50 > 0
            ? parseFloat(((close - ema50) / ema50 * 100).toFixed(2))
            : undefined,
        },
      };

      results.push(signal);
    } catch (err) {
      if (isOptionalOpenAIError(err)) throw err;
      if (err instanceof TypeError) {
        throw new OptionalOpenAIError(`[trendFollower] OpenAI network error for ${symbol}`, {
          code: "openai_network_error",
          cause: err,
        });
      }
      console.error(`[trendFollower] GPT-4o error for ${symbol}:`, err);
      // Skip this symbol — don't crash the whole agent run
    }
  }

  return results;
}
