"use client";

/**
 * components/dashboard/StatsBar.tsx
 * Polls /api/signals every 30s and displays live agent stats.
 */

import { useEffect, useState, useCallback } from "react";
import { MetricTile } from "@/components/ui/MetricTile";

interface Stats {
  activeAgents:   number;
  alertsToday:    number;
  buySignals:     number;
  highConfidence: number;
}

export function StatsBar() {
  const [lastScan, setLastScan] = useState("--:--");
  const [stats, setStats]       = useState<Stats | null>(null);
  const [loading, setLoading]   = useState(true);

  const fetchStats = useCallback(async () => {
    try {
      const res  = await fetch("/api/signals");
      const data = await res.json();
      if (data.stats) {
        setStats(data.stats);
        setLastScan(
          new Date().toLocaleTimeString("en-US", {
            hour:   "2-digit",
            minute: "2-digit",
            hour12: false,
          })
        );
      }
    } catch (err) {
      console.error("[StatsBar] fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const id = setInterval(fetchStats, 30_000);
    return () => clearInterval(id);
  }, [fetchStats]);

  // Show skeleton tiles while loading
  const v = (val: number | undefined, fallback = "--") =>
    loading ? fallback : String(val ?? fallback);

  return (
    <div
      className="flex border-b border-[var(--color-border-default)] shrink-0"
      style={{ gap: "1px", background: "var(--color-border-default)" }}
    >
      <MetricTile
        label="ACTIVE AGENTS"
        value={v(stats?.activeAgents)}
        sub={loading ? "loading…" : `${stats?.activeAgents ?? 0} with signals`}
        subColor="green"
      />
      <MetricTile
        label="ALERTS TODAY"
        value={v(stats?.alertsToday)}
        sub={loading ? "loading…" : "total signals detected"}
        subColor="green"
      />
      <MetricTile
        label="BUY SIGNALS"
        value={v(stats?.buySignals)}
        sub={loading ? "loading…" : `${stats?.highConfidence ?? 0} high confidence`}
        subColor="green"
      />
      <MetricTile
        label="TICKERS WATCHED"
        value="10"
        sub="stocks + crypto"
        subColor="muted"
      />
      <MetricTile
        label="LAST SCAN"
        value={lastScan}
        sub={loading ? "scanning…" : "live"}
        subColor="green"
        valueSize="sm"
      />
    </div>
  );
}
