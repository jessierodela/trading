"use client";

/**
 * components/dashboard/RefreshButton.tsx
 *
 * Manual cache refresh button for the dashboard header.
 * Calls POST /api/cache/refresh and shows:
 *  - Loading spinner while fetch is in progress (taapi is slow — can take 60-90s)
 *  - Last updated timestamp after success
 *  - Error state if fetch fails
 *
 * Drop into <Header /> or wherever makes sense in your layout.
 *
 * Usage:
 *   import { RefreshButton } from "@/components/dashboard/RefreshButton";
 *   <RefreshButton />
 */

import { useState, useEffect } from "react";

type RefreshState = "idle" | "loading" | "success" | "error";

export function RefreshButton() {
  const [state, setState]           = useState<RefreshState>("idle");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [elapsed, setElapsed]         = useState<number>(0);

  // Poll cache status on mount to show last updated time
  useEffect(() => {
    fetch("/api/cache")
      .then((r) => r.json())
      .then((d) => { if (d.lastUpdated) setLastUpdated(d.lastUpdated); })
      .catch(() => {});
  }, []);

  // Elapsed timer while loading — taapi fetches are slow, user needs feedback
  useEffect(() => {
    if (state !== "loading") { setElapsed(0); return; }
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state]);

  async function handleRefresh() {
    if (state === "loading") return;

    setState("loading");

    try {
      const res  = await fetch("/api/cache/refresh", { method: "POST" });
      const data = await res.json();

      if (data.success) {
        setLastUpdated(data.lastUpdated);
        setState("success");
        setTimeout(() => setState("idle"), 3000);
      } else {
        setState("error");
        setTimeout(() => setState("idle"), 4000);
      }
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 4000);
    }
  }

  function formatLastUpdated(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  const isLoading = state === "loading";

  return (
    <div className="flex items-center gap-[8px]">
      {/* Last updated label */}
      {lastUpdated && !isLoading && (
        <span className="text-[9px] text-[var(--color-text-dim)] opacity-50 tabular-nums">
          updated {formatLastUpdated(lastUpdated)}
        </span>
      )}

      {/* Elapsed counter while loading */}
      {isLoading && (
        <span className="text-[9px] text-[var(--color-text-dim)] opacity-60 tabular-nums">
          fetching… {elapsed}s
        </span>
      )}

      {/* Button */}
      <button
        onClick={handleRefresh}
        disabled={isLoading}
        className={[
          "flex items-center gap-[5px] px-[10px] py-[4px] rounded-[4px]",
          "text-[9px] tracking-[.12em] font-medium border transition-all duration-150",
          isLoading
            ? "border-[var(--color-border-default)] text-[var(--color-text-dim)] opacity-50 cursor-not-allowed"
            : state === "success"
            ? "border-[var(--color-accent-green)] text-[var(--color-accent-green)] opacity-80"
            : state === "error"
            ? "border-[var(--color-accent-red)] text-[var(--color-accent-red)] opacity-80"
            : "border-[var(--color-border-default)] text-[var(--color-text-dim)] hover:border-[var(--color-text-dim)] hover:text-[var(--color-text-primary)]",
        ].join(" ")}
      >
        {/* Spinner / icon */}
        <span
          className={[
            "w-[7px] h-[7px] rounded-full border border-current",
            isLoading ? "animate-spin border-t-transparent" : "",
          ].join(" ")}
        />

        {isLoading  ? "PULLING DATA"  :
         state === "success" ? "UPDATED"      :
         state === "error"   ? "FAILED"       :
                               "REFRESH"}
      </button>
    </div>
  );
}