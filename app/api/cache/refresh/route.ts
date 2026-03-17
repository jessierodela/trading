/**
 * app/api/cache/refresh/route.ts
 *
 * POST /api/cache/refresh
 *
 * Full pipeline in one shot:
 *  1. Fetch indicators (taapi) + quotes (yahoo-finance2) → fill indicator cache
 *  2. Run GPT-4o (Momentum Scout AI) with fresh indicator data
 *  3. Run legacy agents (A2–A5) with same data
 *  4. Persist full run to Supabase (signal_runs, indicator_snapshots, signal_results)
 *  5. Write result to L1 memory cache so /api/signals serves it instantly
 *  6. Invalidate old L1 cache before writing new one
 *
 * /api/signals is now read-only — it never triggers GPT-4o itself.
 */

import { NextResponse }                        from "next/server";
import { getCache }                            from "@/lib/indicatorCache";
import { runMomentumScoutAI }                  from "@/lib/agents/momentumScout";
import { persistSignalRun }                    from "@/lib/signalStore";
import { memCache, MEMORY_TTL_MS }             from "@/lib/signalsCache";
import {
  evaluateSignals,
  type AgentResult,
  type DashboardStats,
  buildActivityLog,
} from "@/lib/signals";

export async function POST() {
  const startMs = Date.now();
  const cache   = getCache();

  // ── Step 1: Fetch indicators ─────────────────────────────────────────
  console.log("[cache/refresh] Manual refresh triggered");
  await cache.forceRefresh();

  const snapshot = cache.read();

  if (snapshot.lastFetchFailed || snapshot.data.size === 0) {
    return NextResponse.json(
      { success: false, error: "Indicator fetch failed" },
      { status: 500 }
    );
  }

  // ── Step 2 & 3: Run agents ───────────────────────────────────────────
  console.log("[cache/refresh] Running GPT-4o + legacy agents...");

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

  const activity = buildActivityLog(agentResults);
  const durationMs = Date.now() - startMs;

  const freshResponse = {
    agentResults,
    stats,
    activity,
    generatedAt: new Date().toISOString(),
  };

  // ── Step 5: Write L1 ─────────────────────────────────────────────────
  // Invalidate old cache first, then write fresh result
  memCache.response  = freshResponse;
  memCache.expiresAt = Date.now() + MEMORY_TTL_MS;

  console.log(`[cache/refresh] Complete — ${a1Signals.length} AI signals, ${durationMs}ms total`);

  // ── Step 4: Persist to Supabase (non-blocking) ───────────────────────
  persistSignalRun({ snapshot, a1Signals, agentResults, durationMs })
    .catch((err) => console.error("[cache/refresh] Supabase persist failed:", err));

  return NextResponse.json({
    success:      true,
    lastUpdated:  snapshot.lastUpdated,
    symbolCount:  snapshot.data.size,
    signalCount:  a1Signals.length,
    durationMs,
  });
}