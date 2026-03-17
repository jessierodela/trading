/**
 * lib/agents/momentumScout.ts
 *
 * Momentum Scout AI Agent — GPT-4o powered.
 *
 * Pipeline (per symbol):
 *  1. Read pre-fetched, pre-derived data from indicatorCache (instant)
 *  2. Build structured JSON input payload matching the prompt schema
 *  3. Call GPT-4o with the Momentum Scout system prompt
 *  4. Parse the JSON response into the existing Signal type
 *  5. Return Signal[] — drop-in replacement for the hardcoded momentumScout()
 *
 * The agent never fetches data itself.
 * All indicator + derived field computation lives in indicatorCache.ts.
 */

import type { Signal }       from "@/lib/signals";
import type { CacheSnapshot } from "@/lib/indicatorCache";

// ─── GPT-4o response schema ────────────────────────────────────────────────
// Must match the classification taxonomy in the system prompt exactly.

type MomentumClassification =
  | "acceleration"
  | "trend_continuation"
  | "pullback_to_support"
  | "extended_but_strong"
  | "decelerating"
  | "rollover_risk"
  | "oversold_bounce"
  | "neutral";

interface MomentumScoutResponse {
  symbol:         string;
  classification: MomentumClassification;
  signal_type:    "buy" | "sell" | "watch" | "neutral";
  confidence:     "high" | "medium" | "low";
  reasoning:      string;   // 1–3 sentence plain-English explanation
  key_factors:    string[]; // 2–4 bullet-point factors that drove the call
}

// ─── Classification → SignalType mapping ──────────────────────────────────
// Mirrors the "Signal Type Mapping" section of the system prompt.

const CLASSIFICATION_TO_SIGNAL: Record<MomentumClassification, Signal["type"]> = {
  acceleration:        "buy",
  trend_continuation:  "buy",
  pullback_to_support: "buy",
  extended_but_strong: "watch",
  decelerating:        "watch",
  rollover_risk:       "sell",
  oversold_bounce:     "watch",
  neutral:             "none",
};

// ─── System prompt ─────────────────────────────────────────────────────────
// Loaded once — do not inline into the per-symbol call to avoid repetition.

const SYSTEM_PROMPT = `You are Momentum Scout AI, a technical momentum classification engine.

Your job is to analyze structured technical indicator data for a single symbol on a single timeframe and classify the current momentum state using RSI, MACD, EMA20, and derived bar-to-bar changes.

You are not a chatbot and you are not a financial advisor. You are a deterministic market-state classifier. Your task is to produce a disciplined, conservative classification from the supplied data only.

## Core Principles

Treat the indicators as a combined momentum framework, not as isolated signals:

- EMA20 defines short-term structure and trend context.
- RSI defines momentum regime, momentum health, and extension/exhaustion.
- MACD defines momentum direction and momentum change.
- MACD histogram expansion suggests acceleration.
- MACD histogram contraction suggests deceleration.
- Price relative to EMA20 confirms whether momentum has structural support.
- EMA20 slope confirms whether the short-term trend is strengthening or weakening.

## Interpretation Rules

Follow these rules exactly:

### Trend Context
- Bullish trend context usually requires:
  - priceAboveEma20 = true
  - ema20Slope > 0

- Bearish trend context usually requires:
  - priceAboveEma20 = false
  - ema20Slope < 0

- Neutral or unclear trend context applies when structure is mixed, missing, or contradictory.

### RSI Regime
- RSI above 70 is not automatically bearish.
- RSI below 30 is not automatically bullish.
- In bullish trends:
  - RSI 40-50 often acts like support during pullbacks
  - RSI 50-70 often reflects healthy trend momentum
  - RSI 70-85 can reflect strong continuation or extension
- In bearish trends:
  - RSI 50-60 often acts like resistance
  - RSI below 40 reflects weak momentum or downside pressure

### MACD / Histogram
- hist > 0 means positive momentum is present
- hist < 0 means negative momentum is present
- histChange > 0 means momentum is strengthening
- histChange < 0 means momentum is weakening

### Classification Logic
Choose the single best classification from this list only:

- acceleration
- trend_continuation
- pullback_to_support
- extended_but_strong
- decelerating
- rollover_risk
- oversold_bounce
- neutral

Use these definitions:

- acceleration:
  bullish structure is intact, MACD histogram is positive and expanding, RSI is rising, and momentum is strengthening

- trend_continuation:
  bullish structure is intact, momentum remains positive, RSI is in a healthy trend zone, but acceleration is not the dominant feature

- pullback_to_support:
  bullish structure remains intact, RSI has cooled into a support-like zone, price is near EMA20, and momentum has not clearly broken

- extended_but_strong:
  RSI is elevated and/or price is stretched above EMA20, but MACD momentum remains positive and there is not yet clear rollover evidence

- decelerating:
  bullish structure is still mostly intact, but MACD histogram is shrinking and thrust is weakening, especially when RSI is elevated

- rollover_risk:
  momentum deterioration is becoming meaningful, especially if MACD histogram turns negative, price loses EMA20, EMA20 slope flattens/falls, or multiple signs of weakness align

- oversold_bounce:
  RSI is depressed and MACD is improving, but this is weaker than a true bullish continuation unless structure has recovered

- neutral:
  evidence is mixed, weak, incomplete, or does not strongly support any of the above classes

## Signal Type Mapping
Map the final classification to a signal_type:

- acceleration -> buy
- trend_continuation -> buy
- pullback_to_support -> buy
- extended_but_strong -> watch
- decelerating -> watch
- rollover_risk -> sell
- oversold_bounce -> watch
- neutral -> neutral

## Confidence Rules
Assign confidence as:
- high: indicators strongly align with little contradiction
- medium: setup is reasonably supported but has some mixed evidence
- low: missing data, contradictory evidence, or weak setup

Confidence must be reduced if important fields are missing.

## Output Rules
- Use only the data provided.
- Do not hallucinate missing values.
- Do not infer unseen candles, volume, support, resistance, or market news unless explicitly provided.
- Be conservative.
- Do not label a reversal unless deterioration is evident.
- Do not label something bullish solely because RSI is low.
- Do not label something bearish solely because RSI is high.
- Prefer neutral over forcing a weak classification.
- Return only valid JSON matching this exact schema — no markdown, no commentary outside the JSON:

{
  "symbol": "<symbol>",
  "classification": "<one of the 8 classes>",
  "signal_type": "<buy | sell | watch | neutral>",
  "confidence": "<high | medium | low>",
  "reasoning": "<1-3 sentence plain-English explanation of the classification>",
  "key_factors": ["<factor 1>", "<factor 2>", "<factor 3>"]
}`;

// ─── Payload builder ───────────────────────────────────────────────────────
// Builds the structured JSON the prompt receives as user message.
// Null fields are included explicitly so the model knows data is missing.

function buildPayload(symbol: string, snapshot: CacheSnapshot): object | null {
  const entry = snapshot.data.get(symbol);
  if (!entry) return null;

  const { indicators: ind, derived } = entry;

  return {
    symbol,
    timeframe: "1h",
    rsi:             ind.rsi,
    rsiChange:       derived.rsiChange,
    macdHist:        ind.macd?.valueMACDHist   ?? null,
    macdValue:       ind.macd?.valueMACD        ?? null,
    macdSignal:      ind.macd?.valueMACDSignal  ?? null,
    histChange:      derived.histChange,
    ema20:           ind.ema20,
    priceAboveEma20: derived.priceAboveEma20,
    ema20Slope:      derived.ema20Slope,
    ema20PctDist:    derived.ema20PctDist,
    currentClose:    ind.currentClose,
    prevRsi:         ind.prevRsi,
    prevHist:        ind.prevHist,
    prevEma20:       ind.prevEma20,
  };
}

// ─── GPT-4o call ──────────────────────────────────────────────────────────

async function callGpt4o(payload: object): Promise<MomentumScoutResponse | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("[momentumScout] OPENAI_API_KEY not set");
    return null;
  }

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:       "gpt-4o",
        temperature: 0,           // deterministic — we want consistency, not creativity
        max_tokens:  512,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user",   content: JSON.stringify(payload, null, 2) },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[momentumScout] GPT-4o error ${res.status}:`, err);
      return null;
    }

    const data = await res.json();
    const raw  = data.choices?.[0]?.message?.content ?? "";

    // Strip any accidental markdown fences before parsing
    const clean = raw.replace(/```json|```/gi, "").trim();
    return JSON.parse(clean) as MomentumScoutResponse;

  } catch (err) {
    console.error("[momentumScout] Parse/fetch error:", err);
    return null;
  }
}

// ─── Response → Signal ────────────────────────────────────────────────────

function toSignal(response: MomentumScoutResponse): Signal {
  // Derive signal type from classification (source of truth is the classification,
  // not the model's signal_type field — guards against prompt drift)
  const type = CLASSIFICATION_TO_SIGNAL[response.classification] ?? "none";

  // Combine reasoning + key_factors into the reason string the dashboard displays
  const keyFactorStr = response.key_factors?.length
    ? ` — ${response.key_factors.join("; ")}`
    : "";

  return {
    symbol:     response.symbol,
    agent:      "Momentum Scout AI",
    type,
    reason:     `[${response.classification}] ${response.reasoning}${keyFactorStr}`,
    confidence: response.confidence,
    // Pass classification through as a tag for downstream consumers
    tags:       [response.classification.replace("_risk", "") as any],
  };
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Run Momentum Scout AI across all symbols in the cache.
 * Calls GPT-4o once per symbol — results are independent.
 * Returns Signal[] compatible with the existing evaluateSignals() shape.
 */
export async function runMomentumScoutAI(
  snapshot: CacheSnapshot,
  symbols?: string[]
): Promise<Signal[]> {
  const targets = symbols ?? [
    ...snapshot.stockSymbols,
    ...snapshot.cryptoSymbols,
  ];

  const signals: Signal[] = [];

  // Run all symbols in parallel — GPT-4o calls are independent
  const results = await Promise.allSettled(
    targets.map(async (symbol) => {
      const payload = buildPayload(symbol, snapshot);
      if (!payload) {
        console.warn(`[momentumScout] No cache data for ${symbol} — skipping`);
        return null;
      }

      console.log(`[momentumScout] Calling GPT-4o for ${symbol}...`);
      const response = await callGpt4o(payload);
      if (!response) return null;

      return toSignal(response);
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      signals.push(result.value);
    }
  }

  return signals;
}