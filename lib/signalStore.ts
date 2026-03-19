/**
 * lib/signalStore.ts
 *
 * Persistence layer between the signals route and Supabase.
 *
 * Writes (after every GPT-4o run):
 *   1. signal_runs         — one row for the run
 *   2. indicator_snapshots — one row per symbol
 *   3. signal_results      — one row per symbol (GPT-4o output)
 *
 * Reads (on cold start / empty memory cache):
 *   - Fetches the most recent signal_run + its results from Supabase
 *   - Reconstructs the AgentResult[] shape the dashboard expects
 *   - Serves this as a fallback so signals never disappear after deploys
 *
 * The 1-hour "hold" window is enforced by only serving the last run
 * if it was captured within the past hour.
 */

import { getSupabase, withRetry } from "@/lib/supabase";
import type { CacheSnapshot }     from "@/lib/indicatorCache";
import type { AgentResult }       from "@/lib/signals";
import type { Signal }            from "@/lib/signals";

const HOLD_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// ─── Write ────────────────────────────────────────────────────────────────

export interface PersistPayload {
  snapshot:      CacheSnapshot;
  a1Signals:     Signal[];
  agentResults:  AgentResult[];
  durationMs:    number;
}

export async function persistSignalRun(payload: PersistPayload): Promise<void> {
  const { snapshot, a1Signals, agentResults, durationMs } = payload;
  const allSymbols = [...snapshot.stockSymbols, ...snapshot.cryptoSymbols];

  try {
    // ── 1. signal_runs ──────────────────────────────────────────────────
    const { data: run, error: runError } = await withRetry(
      async () =>
        getSupabase()
          .from("signal_runs")
          .insert({
            triggered_at: new Date().toISOString(),
            trigger:      "manual",
            symbols:      allSymbols,
            model:        "gpt-4o",
            duration_ms:  durationMs,
            success:      true,
          })
          .select("id")
          .single(),
      { label: "signal_runs insert" }
    );

    if (runError || !run) {
      console.error("[signalStore] Failed to insert signal_run:", runError);
      return;
    }

    const runId = run.id;

    // ── 2. indicator_snapshots ──────────────────────────────────────────
    const indicatorRows = allSymbols
      .map((symbol) => {
        const entry = snapshot.data.get(symbol);
        if (!entry) return null;

        const { indicators: ind, derived } = entry;

        return {
          run_id:            runId,
          symbol,
          captured_at:       snapshot.lastUpdated ?? new Date().toISOString(),
          price:             ind.currentClose,
          rsi:               ind.rsi,
          prev_rsi:          ind.prevRsi,
          rsi_change:        derived.rsiChange,
          macd_value:        ind.macd?.valueMACD       ?? null,
          macd_signal:       ind.macd?.valueMACDSignal  ?? null,
          macd_hist:         ind.macd?.valueMACDHist    ?? null,
          prev_hist:         ind.prevHist,
          hist_change:       derived.histChange,
          ema20:             ind.ema20,
          prev_ema20:        ind.prevEma20,
          ema20_slope:       derived.ema20Slope,
          ema20_pct_dist:    derived.ema20PctDist,
          price_above_ema20: derived.priceAboveEma20,
          atr:               ind.atr,
        };
      })
      .filter(Boolean);

    if (indicatorRows.length > 0) {
      const { error: indError } = await withRetry(
        async () =>
          getSupabase()
            .from("indicator_snapshots")
            .insert(indicatorRows),
        { label: "indicator_snapshots insert" }
      );

      if (indError) {
        console.error("[signalStore] Failed to insert indicator_snapshots:", indError);
      }
    }

    // ── 3. signal_results (A1 only for now) ────────────────────────────
    const signalRows = a1Signals.map((sig) => {
      const entry = snapshot.data.get(sig.symbol);

      const classification = sig.reason.match(/^\[([^\]]+)\]/)?.[1] ?? null;
      const reasoning      = sig.reason.replace(/^\[[^\]]+\]\s*/, "").split(" — ")[0].trim();
      const keyFactors     = sig.reason.includes(" — ")
        ? sig.reason.split(" — ")[1].split(";").map((s) => s.trim()).filter(Boolean)
        : [];

      return {
        run_id:          runId,
        symbol:          sig.symbol,
        generated_at:    new Date().toISOString(),
        classification,
        signal_type:     sig.type,
        confidence:      sig.confidence,
        agent:           sig.agent,
        reasoning,
        key_factors:     keyFactors,
        price_at_signal: entry?.indicators.currentClose ?? null,
        raw_response:    {
          type:       sig.type,
          reason:     sig.reason,
          confidence: sig.confidence,
          tags:       sig.tags ?? [],
          context:    sig.context ?? null,
        },
      };
    });

    if (signalRows.length > 0) {
      const { error: sigError } = await withRetry(
        async () =>
          getSupabase()
            .from("signal_results")
            .insert(signalRows),
        { label: "signal_results insert" }
      );

      if (sigError) {
        console.error("[signalStore] Failed to insert signal_results:", sigError);
      }
    }

    console.log(
      `[signalStore] Persisted run ${runId} — ` +
      `${indicatorRows.length} indicator snapshots, ${signalRows.length} signal results`
    );

  } catch (err) {
    // Never let persistence failure break the response to the dashboard
    console.error("[signalStore] Unexpected error (non-fatal):", err);
  }
}

// ─── Read (cold-start fallback) ───────────────────────────────────────────

export interface IndicatorSnapshot {
  symbol:            string;
  captured_at:       string;
  price:             number | null;
  rsi:               number | null;
  prev_rsi:          number | null;
  rsi_change:        number | null;
  macd_value:        number | null;
  macd_signal:       number | null;
  macd_hist:         number | null;
  prev_hist:         number | null;
  hist_change:       number | null;
  ema20:             number | null;
  prev_ema20:        number | null;
  ema20_slope:       number | null;
  ema20_pct_dist:    number | null;
  price_above_ema20: boolean | null;
  atr:               number | null;
}

export interface StoredResponse {
  agentResults:       AgentResult[];
  generatedAt:        string;
  fromStore:          true;
  indicatorSnapshots: IndicatorSnapshot[];
}

export async function loadLastSignalRun(): Promise<StoredResponse | null> {
  try {
    const cutoff = new Date(Date.now() - HOLD_WINDOW_MS).toISOString();

    const { data: run, error: runError } = await withRetry(
      async () =>
        getSupabase()
          .from("signal_runs")
          .select("id, triggered_at")
          .eq("success", true)
          .gte("triggered_at", cutoff)
          .order("triggered_at", { ascending: false })
          .limit(1)
          .single(),
      { label: "signal_runs read" }
    );

    if (runError || !run) {
      console.log("[signalStore] No recent run found in Supabase (within 1hr)");
      return null;
    }

    const { data: results, error: resError } = await withRetry(
      async () =>
        getSupabase()
          .from("signal_results")
          .select("*")
          .eq("run_id", run.id),
      { label: "signal_results read" }
    );

    if (resError || !results || results.length === 0) {
      console.log("[signalStore] No signal_results for run", run.id);
      return null;
    }

    const signals: Signal[] = results.map((row: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
      symbol:     row.symbol,
      agent:      row.agent,
      type:       row.signal_type as Signal["type"],
      confidence: row.confidence  as Signal["confidence"],
      reason:     row.classification
        ? `[${row.classification}] ${row.reasoning}${
            row.key_factors?.length ? ` — ${row.key_factors.join("; ")}` : ""
          }`
        : row.reasoning ?? "",
      tags: row.classification ? [row.classification] : [],
    }));

    const a1Result: AgentResult = {
      id:          "A1",
      name:        "Momentum Scout AI",
      signalCount: signals.length,
      alertCount:  signals.filter((s) => s.confidence === "high").length,
      lastAction:  signals.length
        ? `Flagged ${signals[0].symbol} — ${signals[0].reason.slice(0, 50)}…`
        : "Scanning — no qualifying setups",
      signals,
    };

    // Also fetch indicator snapshots for this run so the panel
    // can display indicator data even after a cold start / cache wipe
    const { data: snapshots } = await withRetry(
      async () =>
        getSupabase()
          .from("indicator_snapshots")
          .select("symbol, captured_at, price, rsi, prev_rsi, rsi_change, macd_value, macd_signal, macd_hist, prev_hist, hist_change, ema20, prev_ema20, ema20_slope, ema20_pct_dist, price_above_ema20, atr")
          .eq("run_id", run.id),
      { label: "indicator_snapshots read" }
    );

    console.log(
      `[signalStore] Loaded last run from ${run.triggered_at} — ` +
      `${signals.length} signals, ${snapshots?.length ?? 0} indicator snapshots`
    );

    return {
      agentResults:       [a1Result],
      generatedAt:        run.triggered_at,
      fromStore:          true,
      indicatorSnapshots: (snapshots ?? []) as IndicatorSnapshot[],
    };

  } catch (err) {
    console.error("[signalStore] Read failed (non-fatal):", err);
    return null;
  }
}
