"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type RefreshState = "idle" | "queueing" | "queued" | "running" | "success" | "error";

interface PresentedJob {
  id: string;
  status: string;
  error: string | null;
}

interface JobStatusResponse {
  success: boolean;
  job?: PresentedJob;
  error?: string;
}

export function refreshStateFromJobStatus(status: string): RefreshState {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "success";
    case "failed":
    case "dead":
    case "cancelled":
      return "error";
    default:
      return "error";
  }
}

export function isRefreshBusy(state: RefreshState): boolean {
  return state === "queueing" || state === "queued" || state === "running";
}

export function RefreshButton() {
  const [state, setState] = useState<RefreshState>("idle");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number>(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch("/api/cache")
      .then((r) => r.json())
      .then((d) => {
        if (d.lastUpdated) setLastUpdated(d.lastUpdated);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isRefreshBusy(state)) {
      setElapsed(0);
      return;
    }
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state]);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const scheduleReset = useCallback((delayMs: number) => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      setState("idle");
      setErrorMessage(null);
      resetTimerRef.current = null;
    }, delayMs);
  }, []);

  const fetchSignalsAfterSuccess = useCallback(async () => {
    const res = await fetch("/api/signals");
    if (!res.ok) throw new Error("Signals fetch failed after refresh");
    const data = await res.json();
    if (typeof data?.generatedAt === "string") setLastUpdated(data.generatedAt);
    window.dispatchEvent(new CustomEvent("signals:update", { detail: data }));
  }, []);

  useEffect(() => {
    if (!jobId || (state !== "queued" && state !== "running")) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
        const data: JobStatusResponse = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.success || !data.job) {
          throw new Error(data.error ?? "Job status fetch failed");
        }

        const nextState = refreshStateFromJobStatus(data.job.status);
        setState(nextState);

        if (nextState === "queued" || nextState === "running") {
          timer = setTimeout(poll, 1500);
          return;
        }

        setJobId(null);
        if (nextState === "success") {
          await fetchSignalsAfterSuccess();
          if (!cancelled) scheduleReset(3000);
          return;
        }

        setErrorMessage(data.job.error ?? `Refresh job ${data.job.status}`);
        scheduleReset(5000);
      } catch (err) {
        if (cancelled) return;
        setJobId(null);
        setState("error");
        setErrorMessage(err instanceof Error ? err.message : String(err));
        scheduleReset(5000);
      }
    };

    timer = setTimeout(poll, 1200);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchSignalsAfterSuccess, jobId, scheduleReset, state]);

  async function handleRefresh() {
    if (isRefreshBusy(state)) return;
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    setState("queueing");
    setErrorMessage(null);

    try {
      const res = await fetch("/api/cache/refresh", { method: "POST" });
      const data = await res.json();

      if (!res.ok || !data.success || !data.queued || typeof data.jobId !== "string") {
        throw new Error(data.error ?? "Refresh queue request failed");
      }

      setJobId(data.jobId);
      setState(refreshStateFromJobStatus(data.status ?? "queued"));
    } catch (err) {
      setJobId(null);
      setState("error");
      setErrorMessage(err instanceof Error ? err.message : String(err));
      scheduleReset(5000);
    }
  }

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  const busy = isRefreshBusy(state);
  const statusText =
    state === "queueing" ? "queueing..." :
    state === "queued" ? `queued ${elapsed}s` :
    state === "running" ? `running ${elapsed}s` :
    errorMessage ? errorMessage : null;
  const buttonText =
    state === "queueing" ? "QUEUEING" :
    state === "queued" ? "QUEUED" :
    state === "running" ? "RUNNING" :
    state === "success" ? "UPDATED" :
    state === "error" ? "FAILED" :
    "REFRESH";

  return (
    <div className="flex items-center gap-[8px]">
      {lastUpdated && !busy && (
        <span className="text-[9px] text-[var(--color-text-dim)] opacity-50 tabular-nums">
          updated {formatTime(lastUpdated)}
        </span>
      )}
      {statusText && (
        <span className="max-w-[180px] truncate text-[9px] text-[var(--color-text-dim)] opacity-60 tabular-nums">
          {statusText}
        </span>
      )}
      <button
        onClick={handleRefresh}
        disabled={busy}
        className={[
          "flex items-center gap-[5px] px-[10px] py-[4px] rounded-[4px]",
          "text-[9px] tracking-[.12em] font-medium border transition-all duration-150",
          busy
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
          busy ? "animate-spin border-t-transparent" : "",
        ].join(" ")} />
        {buttonText}
      </button>
    </div>
  );
}
