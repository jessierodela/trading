/**
 * lib/agents/breakoutWatcher.ts
 *
 * Breakout Watcher Agent — GPT-4o powered.
 *
 * Pipeline (per symbol):
 *  1. Read pre-fetched BB + volume data from indicatorCache (instant)
 *  2. Build structured JSON payload matching the prompt schema
 *  3. Call GPT-4o with the Breakout Watcher system prompt + JSON schema enforcement
 *  4. Parse structured response → Signal[]
 *
 * The agent never fetches data. All indicator data lives in indicatorCache.ts.
 * BB data requires "bb" to be enabled in config/indicators.ts for the symbol.
 */

import type { Signal } from "@/lib/signals";
import type { CacheSnapshot } from "@/lib/indicatorCache";
import {
  isOptionalOpenAIError,
  OptionalOpenAIError,
  optionalOpenAIHttpError,
} from "@/lib/openai/config";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

// ─── GPT-4o response shape ────────────────────────────────────────────────

interface BreakoutWatcherOutput {
  structure: {
    price_vs_bands:   "above_upper_band" | "at_upper_band" | "inside_bands" | "at_lower_band" | "below_lower_band";
    volatility_state: "compressed" | "neutral" | "expanding" | "extended";
    range_context:    "near_range_high" | "mid_range" | "near_range_low" | "unknown";
    squeeze_present:  boolean;
    summary:          string;
  };
  breakout_conditions: {
    upper_band_breach:  boolean;
    lower_band_breach:  boolean;
    close_quality:      "strong_close" | "weak_close" | "wick_only" | "unknown";
    band_width_direction: "contracting" | "flat" | "expanding" | "unknown";
    volume_confirmation: "strong" | "moderate" | "weak" | "absent" | "unknown";
    extension_risk:     "low" | "moderate" | "high" | "unknown";
    summary:            string;
  };
  implication: {
    signal:     "BUY" | "SELL" | "WATCH";
    confidence: "High" | "Moderate" | "Low";
    summary:    string;
  };
}

// ─── System prompt ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Breakout Watcher, a market structure agent specialized in detecting Bollinger Band breakout conditions.

Your job is to evaluate whether price is breaking out of a volatility compression or band expansion setup using Bollinger Bands, band width, and volume confirmation.

You must reason in exactly three sections: Structure, Breakout Conditions, Implication.

Your goal is not to predict the future with certainty. Your goal is to assess whether current conditions support a credible breakout, breakdown, or watchlist setup.

You are given precomputed indicator data. Use only the supplied data. Do not invent missing values.

STRUCTURE
- Determine whether price is trading near, at, above, or below the Bollinger Bands.
- Identify whether the market appears compressed, expanding, or already extended.
- Note whether price is near a recent range high, range low, or in the middle of the range.
- Identify whether a squeeze appears to be forming based on low or contracting band width.

BREAKOUT CONDITIONS
- Bullish: price closes above upper BB with expanding band width and supportive volume.
- Bearish: price closes below lower BB with expanding band width and supportive volume.
- Squeeze: narrow/contracted band width = consolidation; breakout may be forming but not yet confirmed.
- Volume confirmation strengthens a breakout. Weak or absent volume reduces conviction.
- Avoid overstating conviction if price only wicks outside a band without a strong close.
- If price is already far beyond the band (>2% extension), note extension/exhaustion risk.

IMPLICATION
- BUY = bullish breakout conditions confirmed
- SELL = bearish breakdown conditions confirmed
- WATCH = squeeze forming, weak confirmation, or inconclusive

STYLE: Concise, analytical, disciplined. No hype. No disclaimers. No chain-of-thought.

Return ONLY a valid JSON object — no markdown, no preamble — matching this exact schema:
{
  "structure": {
    "price_vs_bands": "above_upper_band"|"at_upper_band"|"inside_bands"|"at_lower_band"|"below_lower_band",
    "volatility_state": "compressed"|"neutral"|"expanding"|"extended",
    "range_context": "near_range_high"|"mid_range"|"near_range_low"|"unknown",
    "squeeze_present": boolean,
    "summary": "string"
  },
  "breakout_conditions": {
    "upper_band_breach": boolean,
    "lower_band_breach": boolean,
    "close_quality": "strong_close"|"weak_close"|"wick_only"|"unknown",
    "band_width_direction": "contracting"|"flat"|"expanding"|"unknown",
    "volume_confirmation": "strong"|"moderate"|"weak"|"absent"|"unknown",
    "extension_risk": "low"|"moderate"|"high"|"unknown",
    "summary": "string"
  },
  "implication": {
    "signal": "BUY"|"SELL"|"WATCH",
    "confidence": "High"|"Moderate"|"Low",
    "summary": "string"
  }
}`;

// ─── Payload builder ──────────────────────────────────────────────────────

/**
 * Derive range position from price vs BB levels.
 * If the cache has an explicit recent_range_position, prefer that.
 * Otherwise infer from where price sits relative to the bands.
 */
function inferRangePosition(
  close: number,
  bbUpper: number,
  bbLower: number
): "near_range_high" | "mid_range" | "near_range_low" | "unknown" {
  const range = bbUpper - bbLower;
  if (range <= 0) return "unknown";
  const position = (close - bbLower) / range; // 0 = at lower, 1 = at upper
  if (position >= 0.75) return "near_range_high";
  if (position <= 0.25) return "near_range_low";
  return "mid_range";
}

/**
 * Derive candle close quality from price vs upper/lower band.
 * Taapi gives us the close price and band levels — we can infer quality.
 * A "strong close" = price closed clearly above/below the band by >0.1%.
 * A "wick only" would require OHLC data we don't have, so we default to strong/weak.
 */
function inferCloseQuality(
  close: number,
  bbUpper: number,
  bbLower: number
): "strong_close" | "weak_close" | "wick_only" | "unknown" {
  const aboveUpper = (close - bbUpper) / bbUpper;
  const belowLower = (bbLower - close) / bbLower;

  if (aboveUpper > 0.002) return "strong_close";  // >0.2% above upper = strong
  if (aboveUpper > 0)     return "weak_close";     // barely above
  if (belowLower > 0.002) return "strong_close";   // >0.2% below lower = strong breakdown
  if (belowLower > 0)     return "weak_close";
  return "unknown"; // inside bands — not applicable for breach quality
}

// ─── Main agent function ──────────────────────────────────────────────────

/**
 * Run Breakout Watcher on all symbols that have BB data in the cache.
 * Skips symbols missing bb_upper/bb_lower/bb_width (not enabled in indicators config).
 */
export async function runBreakoutWatcher(
  snapshot: CacheSnapshot,
  timeframe: string = "1h"
): Promise<Signal[]> {
  const results: Signal[] = [];

  for (const [symbol, data] of snapshot.data.entries()) {
    const { indicators } = data;

    // Skip symbols that don't have BB data fetched
    if (
      indicators.bb == null ||
      indicators.bb_width == null
    ) {
      continue;
    }

    const bbUpper      = indicators.bb.valueUpperBand;
    const bbLower      = indicators.bb.valueLowerBand;
    const bbMiddle     = indicators.bb.valueMiddleBand;
    const bbWidth      = indicators.bb_width;
    const bbWidthPrev  = indicators.bb_width_prev ?? bbWidth;
    const close        = indicators.currentClose ?? bbMiddle;
    const volume       = indicators.volume ?? 0;
    const volumeAvg20  = indicators.volumeSma20 ?? volume;
    const relVol       = volumeAvg20 > 0 ? volume / volumeAvg20 : 1.0;

    const rangePosition = inferRangePosition(close, bbUpper, bbLower);
    const closeQuality  = inferCloseQuality(close, bbUpper, bbLower);

    const payload = {
      agent:      "breakout_watcher",
      timeframe,
      symbol,
      indicators: {
        close,
        bb_upper:              bbUpper,
        bb_middle:             bbMiddle,
        bb_lower:              bbLower,
        bb_width:              bbWidth,
        bb_width_prev:         bbWidthPrev,
        volume,
        volume_avg_20:         volumeAvg20,
        relative_volume:       parseFloat(relVol.toFixed(2)),
        recent_range_position: rangePosition,
        candle_close_strength: closeQuality,
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
            { role: "user",   content: `Analyze this breakout setup:\n${JSON.stringify(payload, null, 2)}` },
          ],
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        const optionalErr = optionalOpenAIHttpError("breakoutWatcher", res.status, errText);
        if (optionalErr) throw optionalErr;
        console.error(`[breakoutWatcher] OpenAI error for ${symbol}: ${res.status} — ${errText}`);
        continue;
      }

      const json = await res.json();
      const raw   = json.choices?.[0]?.message?.content ?? "";
      const clean = raw.replace(/```json|```/g, "").trim();
      const result: BreakoutWatcherOutput = JSON.parse(clean);

      const { implication, structure, breakout_conditions } = result;

      // Map to the Signal type used by the rest of the dashboard.
      // Full reasoning packed into reason string; context carries numeric fields.
      const signal: Signal = {
        agent:      "Breakout Watcher",
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
          `Breakout: ${breakout_conditions.summary}`,
          `Vol: ${breakout_conditions.volume_confirmation} | Extension risk: ${breakout_conditions.extension_risk}`,
        ].join(" — "),
        tags: [structure.volatility_state as any],
        context: {
          ema20PctDistance: bbMiddle > 0
            ? parseFloat(((close - bbMiddle) / bbMiddle * 100).toFixed(2))
            : undefined,
        },
      };

      results.push(signal);
    } catch (err) {
      if (isOptionalOpenAIError(err)) throw err;
      if (err instanceof TypeError) {
        throw new OptionalOpenAIError(`[breakoutWatcher] OpenAI network error for ${symbol}`, {
          code: "openai_network_error",
          cause: err,
        });
      }
      console.error(`[breakoutWatcher] GPT-4o error for ${symbol}:`, err);
      // Skip this symbol — don't crash the whole agent run
    }
  }

  return results;
}
