/**
 * app/api/signals/route.ts
 *
 * Signal persistence layer:
 *  L1 — In-memory cache (90s TTL)   — fastest, lost on cold start
 *  L2 — Supabase (1hr hold window)  — survives deploys, enables backtesting
 *
 * Read order:  L1 → L2 → run GPT-4o → write both
 * Write order: after every GPT-4o run → write L1 + L2 (Supabase)
 */

import { NextResponse }         from "next/server";
import { getCache }             from "@/lib/indicatorCache";
import { runMomentumScoutAI }   from "@/lib/agents/momentumScout";
import { persistSignalRun, loadLastSignalRun } from "@/lib/signalStore";
import {
  evaluateSignals,
  type AgentResult,
  type DashboardStats,
  type LiveActivityEntry,
  buildActivityLog,
} from "@/lib/signals";

// ─── L1 in-memory cache ───────────────────────────────────────────────────

const MEMORY_TTL_MS = 90_000;
let memCachedResponse: object | null = null;
let memCacheExpiresAt: number        = 0;

export function invalidateSignalsCache(): void {
  memCachedResponse = null;
  memCacheExpiresAt = 0;
  console.log("[signals] L1 cache invalidated — next poll will run GPT-4o");
}

// ─── Route ────────────────────────────────────────────────────────────────

export async function GET() {
  // L1: in-memory hit — serve immediately
  if (memCachedResponse && Date.now() < memCacheExpiresAt) {
    return NextResponse.json(memCachedResponse);
  }

  const cache    = getCache();
  const snapshot = cache.read();

  // No fresh indicator data — fall back to Supabase before returning empty
  if (snapshot.data.size === 0) {
    const stored = await loadLastSignalRun();
    if (stored) {
      // Warm L1 from Supabase
      memCachedResponse = stored;
      memCacheExpiresAt = Date.now() + MEMORY_TTL_MS;
      return NextResponse.json(stored);
    }
    return NextResponse.json(
      { agentResults: [], stats: null, activity: [] },
      { status: 200 }
    );
  }

  // L2: cold start with indicator data present — check Supabase first
  if (!memCachedResponse) {
    const stored = await loadLastSignalRun();
    if (stored) {
      memCachedResponse = stored;
      memCacheExpiresAt = Date.now() + MEMORY_TTL_MS;
      return NextResponse.json(stored);
    }
  }

  // ── Fresh GPT-4o run ──────────────────────────────────────────────────

  const startMs = Date.now();

  const indicatorMap = new Map(
    [...snapshot.data.entries()].map(([sym, entry]) => [sym, entry.indicators])
  );
  const quoteMap = new Map(
    [...snapshot.data.entries()]
      .filter(([, entry]) => entry.quote !== null)
      .map(([sym, entry]) => [sym, { price: entry.quote!.price }])
  );

  const [a1Signals, legacyResults] = await Promise.all([
    runMomentumScoutAI(snapshot),
    evaluateSignals(
      indicatorMap,
      quoteMap,
      snapshot.stockSymbols,
      snapshot.cryptoSymbols
    ),
  ]);

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

  const agentResults: AgentResult[] = [
    a1Result,
    ...legacyResults.agentResults.slice(1),
  ];

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

  const response = {
    agentResults,
    stats,
    activity,
    generatedAt: new Date().toISOString(),
  };

  const durationMs = Date.now() - startMs;

  // Write L1
  memCachedResponse = response;
  memCacheExpiresAt = Date.now() + MEMORY_TTL_MS;

  // Write L2 — non-blocking, never delays response
  persistSignalRun({
    snapshot,
    a1Signals,
    agentResults,
    durationMs,
  }).catch((err) => console.error("[signals] Supabase persist failed:", err));

  return NextResponse.json(response);
}