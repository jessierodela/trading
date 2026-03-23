/**
 * lib/confluence/confluenceEngine.ts
 *
 * Confluence Engine — post-processing layer that runs after all five agents.
 *
 * Per symbol:
 *  1. Collect all agent signals for that symbol
 *  2. Run deterministic scorer (scoreSymbol) → ConfluenceVerdict + weighted score
 *  3. Call GPT-4o with the verdict + agent summaries → one concise narrative paragraph
 *  4. Return ConfluenceResult[] — one entry per symbol that met the gate
 *
 * This is NOT a sixth agent. It never fetches indicators.
 * It reasons only over structured Signal[] outputs from A1–A5.
 *
 * Integration: called from route.ts after Promise.all resolves.
 * Output is added to the response payload for UI consumption.
 */

import type { Signal } from "@/lib/signals";
import { scoreSymbol, type ConfluenceVerdict, type ScoringResult } from "./scoreSignals";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ConfluenceResult {
  symbol:        string;
  verdict:       ConfluenceVerdict;
  weightedScore: number;
  narrative:     string;           // GPT-generated concise summary
  tags:          string[];         // e.g. ["mean_reversion_confluence", "a4_veto"]
  agentVotes: {
    agent:      string;
    signal:     string;
    confidence: string;
    score:      number;
  }[];
  gateMet:         boolean;
  hasHardConflict: boolean;
}

// ─── Verdict labels ─────────────────────────────────────────────────────────
// Human-readable form passed to GPT in the narrative prompt.

const VERDICT_LABELS: Record<ConfluenceVerdict, string> = {
  aligned_bullish:     "Aligned Bullish — majority of agents agree on bullish direction",
  bullish_but_extended: "Bullish But Extended — bullish lean with elevated chase or extension risk",
  mixed_structure:     "Mixed Structure — agents disagree, no clear directional edge",
  bearish_structure:   "Bearish Structure — majority of agents lean bearish",
  countertrend_only:   "Countertrend Only — oversold bounce signal without trend support",
  no_trade:            "No Trade — gate not met, insufficient data, or active agent conflict",
};

// ─── GPT narrative prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior trading system analyst writing a concise confluence summary.

You are given:
- A symbol
- A deterministic confluence verdict and weighted score from a multi-agent system
- A brief summary from each agent that contributed a signal

Your job is to write ONE paragraph (3–5 sentences) that explains:
1. What the overall verdict means for this symbol right now
2. Which agents are in agreement and which are conflicting or absent
3. Whether this represents a tradeable setup or a situation to monitor

Rules:
- Be direct and analytical. No hedging language like "it seems" or "perhaps".
- Do not recommend position sizing or specific entry prices.
- Do not repeat the verdict label verbatim — explain what it means in context.
- If the verdict is no_trade or mixed_structure, explain what would need to change.
- Keep it under 80 words.
- Return ONLY the paragraph text. No JSON. No markdown. No preamble.`;

// ─── Build narrative input ──────────────────────────────────────────────────

function buildNarrativeInput(
  symbol:   string,
  scoring:  ScoringResult,
  signals:  Signal[],
): string {
  const verdictLabel = VERDICT_LABELS[scoring.verdict];

  const agentSummaries = signals
    .filter((s) => s.agent !== "Mean Reversion" || scoring.a5Present)
    .map((s) => {
      // Extract the implication summary from reason string (first segment before " — ")
      const firstSegment = s.reason.split(" — ")[0] ?? s.reason;
      return `${s.agent} (${s.type}, ${s.confidence}): ${firstSegment}`;
    })
    .join("\n");

  const modifiers: string[] = [];
  if (scoring.a4VetoActive)  modifiers.push("A4 Volatility Arbiter flagged high chase/extension risk");
  if (scoring.a5Present && scoring.a5Signal === "buy") modifiers.push("A5 Mean Reversion firing — oversold bounce conditions present");
  if (scoring.hasHardConflict) modifiers.push("Hard conflict: A1 and A3 disagree on direction");

  return `Symbol: ${symbol}
Verdict: ${verdictLabel}
Weighted score: ${scoring.weightedScore} (range: -8 to +8)
${modifiers.length ? `Active modifiers:\n${modifiers.map((m) => `- ${m}`).join("\n")}` : "No active modifiers"}

Agent signals:
${agentSummaries}

Write the confluence narrative.`.trim();
}

// ─── GPT narrative call ─────────────────────────────────────────────────────

async function fetchNarrative(input: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "Narrative unavailable — OPENAI_API_KEY not set.";

  try {
    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:       "gpt-4o",
        temperature: 0.3,  // slight variation for natural prose, still controlled
        max_tokens:  160,  // 80 words × ~2 tokens/word + headroom
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user",   content: input },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[confluenceEngine] GPT narrative error: ${res.status} — ${err}`);
      return "Narrative unavailable — GPT call failed.";
    }

    const data = await res.json();
    return (data.choices?.[0]?.message?.content ?? "").trim();

  } catch (err) {
    console.error("[confluenceEngine] Narrative fetch error:", err);
    return "Narrative unavailable — network error.";
  }
}

// ─── Derive result tags ─────────────────────────────────────────────────────

function deriveTags(scoring: ScoringResult): string[] {
  const tags: string[] = [];

  if (scoring.a4VetoActive)  tags.push("a4_veto");
  if (scoring.hasHardConflict) tags.push("agent_conflict");

  if (scoring.a5Present && scoring.a5Signal === "buy") {
    if (scoring.verdict === "aligned_bullish") {
      tags.push("mean_reversion_confluence"); // bounce + trend agreement = stronger setup
    } else {
      tags.push("countertrend_bounce");
    }
  }

  return tags;
}

// ─── Main engine ────────────────────────────────────────────────────────────

/**
 * Run confluence analysis for all symbols that appear in any agent's Signal[].
 *
 * @param allSignals - Flat array of Signal[] from all five agents combined.
 *                     Each signal has a .symbol field used for grouping.
 * @returns ConfluenceResult[] — one entry per symbol that met the gate (A1 + A3 present).
 *          Symbols that don't meet the gate are omitted (no_trade results suppressed
 *          unless at least one agent fired, to avoid noise).
 */
export async function runConfluenceEngine(
  allSignals: Signal[]
): Promise<ConfluenceResult[]> {

  // ── Group signals by symbol ────────────────────────────────────────────
  const bySymbol = new Map<string, Signal[]>();
  for (const signal of allSignals) {
    if (!bySymbol.has(signal.symbol)) bySymbol.set(signal.symbol, []);
    bySymbol.get(signal.symbol)!.push(signal);
  }

  // ── Score + narrate in parallel (one GPT call per symbol) ──────────────
  const settled = await Promise.allSettled(
    [...bySymbol.entries()].map(async ([symbol, signals]) => {
      const scoring = scoreSymbol(signals);

      // Suppress no_trade symbols where gate wasn't met and no agents fired —
      // these are symbols with no data at all, not worth surfacing.
      if (!scoring.gateMet && scoring.votes.length === 0) return null;

      const narrativeInput = buildNarrativeInput(symbol, scoring, signals);
      const narrative      = await fetchNarrative(narrativeInput);
      const tags           = deriveTags(scoring);

      const result: ConfluenceResult = {
        symbol,
        verdict:       scoring.verdict,
        weightedScore: scoring.weightedScore,
        narrative,
        tags,
        agentVotes: scoring.votes.map((v) => ({
          agent:      v.agentName,
          signal:     v.signal,
          confidence: v.confidence,
          score:      v.score,
        })),
        gateMet:         scoring.gateMet,
        hasHardConflict: scoring.hasHardConflict,
      };

      console.log(
        `[confluenceEngine] ${symbol} → ${scoring.verdict} ` +
        `(score: ${scoring.weightedScore}, tags: [${tags.join(", ")}])`
      );

      return result;
    })
  );

  const results: ConfluenceResult[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled" && s.value !== null) {
      results.push(s.value);
    } else if (s.status === "rejected") {
      console.warn("[confluenceEngine] Symbol failed:", s.reason);
    }
  }

  return results;
}
