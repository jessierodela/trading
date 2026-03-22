"use client";

/**
 * components/dashboard/RefreshButton.tsx
 *
 * Triggers POST /api/cache/refresh.
 * On success, dispatches a "signals:update" custom event with the full
 * payload so SignalsPanel updates instantly — no poll delay.
 */

import { useState, useEffect } from "react";

type RefreshState = "idle" | "loading" | "success" | "error";

export function RefreshButton() {
  const [state, setState]             = useState<RefreshState>("idle");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [elapsed, setElapsed]         = useState<number>(0);

  useEffect(() => {
    fetch("/api/cache")
      .then((r) => r.json())
      .then((d) => { if (d.lastUpdated) setLastUpdated(d.lastUpdated); })
      .catch(() => {});
  }, []);

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
        setLastUpdated(data.generatedAt);
        setState("success");
        setTimeout(() => setState("idle"), 3000);

        // Push data directly to SignalsPanel — instant, no poll wait
        window.dispatchEvent(new CustomEvent("signals:update", { detail: data }));
      } else {
        setState("error");
        setTimeout(() => setState("idle"), 4000);
      }
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 4000);
    }
  }

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }

  const isLoading = state === "loading";

  return (
    <div className="flex items-center gap-[8px]">
      {lastUpdated && !isLoading && (
        <span className="text-[9px] text-[var(--color-text-dim)] opacity-50 tabular-nums">
          updated {formatTime(lastUpdated)}
        </span>
      )}
      {isLoading && (
        <span className="text-[9px] text-[var(--color-text-dim)] opacity-60 tabular-nums">
          fetching… {elapsed}s
        </span>
      )}
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
        <span className={[
          "w-[7px] h-[7px] rounded-full border border-current",
          isLoading ? "animate-spin border-t-transparent" : "",
        ].join(" ")} />
        {isLoading         ? "PULLING DATA" :
         state === "success" ? "UPDATED"    :
         state === "error"   ? "FAILED"     : "REFRESH"}
      </button>
    </div>
  );
}
