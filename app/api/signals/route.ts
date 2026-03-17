/**
 * app/api/signals/route.ts
 *
 * Main signals endpoint — now wires Momentum Scout AI (GPT-4o) for A1,
 * while A2–A5 continue running their existing hardcoded logic from signals.ts.
 *
 * Architecture:
 *  - Cache provides all indicator + price data (pre-fetched, pre-derived)
 *  - A1 (Momentum Scout AI) reads cache → calls GPT-4o → returns AI Signal[]
 *  - A2–A5 read from the same cache snapshot → run deterministic logic
 *  - All results merged into the existing AgentResult[] shape
 *
 * The existing SignalsPanel.tsx, StatsBar, and ActivityLog are unchanged.
 */

import { NextResponse }         from "next/server";
import { getCache }             from "@/lib/indicatorCache";
import { runMomentumScoutAI }   from "@/lib/agents/momentumScout";
import {
  evaluateSignals,
  type AgentResult,
  type DashboardStats,
  type LiveActivityEntry,
  buildActivityLog,
} from "@/lib/signals";

// Simple in-memory response cache to avoid re-running GPT-4o on every poll.
// TTL matches the 90s client poll interval from polling.ts.
const RESPONSE_CACHE_TTL_MS = 90_000;
let cachedResponse:  object | null = null;
let cacheExpiresAt:  number        = 0;

export async function GET() {
  // ── Serve cached response if still fresh ──────────────────────────────
  if (cachedResponse && Date.now() < cacheExpiresAt) {
    return NextResponse.json(cachedResponse);
  }

  const cache    = getCache();
  const snapshot = cache.read();

  if (snapshot.data.size === 0) {
    return NextResponse.json(
      { agentResults: [], stats: null, activity: [] },
      { status: 200 }
    );
  }

  // ── Build indicator + quote maps for legacy agents (A2–A5) ─────────────
  // These agents still use the Map<string, IndicatorValues> interface from signals.ts.
  const indicatorMap = new Map(
    [...snapshot.data.entries()].map(([sym, entry]) => [sym, entry.indicators])
  );
  const quoteMap = new Map(
    [...snapshot.data.entries()]
      .filter(([, entry]) => entry.quote !== null)
      .map(([sym, entry]) => [sym, { price: entry.quote!.price }])
  );

  // ── Run agents in parallel ─────────────────────────────────────────────
  const [a1Signals, legacyResults] = await Promise.all([
    // A1: Momentum Scout AI (GPT-4o)
    runMomentumScoutAI(snapshot),

    // A2–A5: existing deterministic logic
    evaluateSignals(
      indicatorMap,
      quoteMap,
      snapshot.stockSymbols,
      snapshot.cryptoSymbols
    ),
  ]);

  // ── Replace A1 in the agentResults array with the AI version ──────────
  const a1Result: AgentResult = {
    id:          "A1",
    name:        "Momentum Scout AI",
    signalCount: a1Signals.length,
    alertCount:  a1Signals.filter((s) => s.confidence === "high").length,
    lastAction:  a1Signals.length
      ? `Flagged ${a1Signals[0].symbol} — ${a1Signals[0].reason.slice(0, 50)}…`
      : "Scanning — no qualifying setups",
    signals: a1Signals,
  };

  // legacyResults.agentResults[0] is the old hardcoded A1 — replace it
  const agentResults: AgentResult[] = [
    a1Result,
    ...legacyResults.agentResults.slice(1), // A2, A3, A4, A5
  ];

  // ── Recompute stats across all agents ─────────────────────────────────
  const allSignals   = agentResults.flatMap((a) => a.signals);
  const buySignals   = allSignals.filter((s) => s.type === "buy");
  const highConf     = buySignals.filter((s) => s.confidence === "high");
  const activeAgents = agentResults.filter((a) => a.signalCount > 0).length;

  const stats: DashboardStats = {
    activeAgents,
    alertsToday:    allSignals.length,
    buySignals:     buySignals.length,
    highConfidence: highConf.length,
  };

  const activity: LiveActivityEntry[] = buildActivityLog(agentResults);

  const response = { agentResults, stats, activity };

  // Cache response for 90s
  cachedResponse  = response;
  cacheExpiresAt  = Date.now() + RESPONSE_CACHE_TTL_MS;

  return NextResponse.json(response);
}