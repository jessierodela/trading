"use client";

import { useEffect, useState } from "react";
import { MetricTile } from "@/components/ui/MetricTile";

export function StatsBar() {
  const [lastScan, setLastScan] = useState("--:--");

  useEffect(() => {
    const tick = () => {
      setLastScan(
        new Date().toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      );
    };
    tick();
    const id = setInterval(tick, 60000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex border-b border-[var(--color-border-default)] shrink-0" style={{ gap: "1px", background: "var(--color-border-default)" }}>
      <MetricTile label="ACTIVE AGENTS"   value="4"        sub="2 scanning now"    subColor="green" />
      <MetricTile label="ALERTS TODAY"    value="17"       sub="+5 last hour"      subColor="green" />
      <MetricTile label="BUY SIGNALS"     value="6"        sub="3 high confidence" subColor="green" />
      <MetricTile label="TICKERS WATCHED" value="10"       sub="stocks + crypto"   subColor="muted" />
      <MetricTile label="LAST SCAN"       value={lastScan} sub="live"              subColor="green" valueSize="sm" />
    </div>
  );
}
