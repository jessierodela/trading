import type { P8OpsSummary } from "@/lib/ops/p8Types";
import { formatTimestamp, OpsPanel, OpsStatusPill } from "./P8OpsUI";

export function P8RegimeFreshness({ data }: { data: P8OpsSummary }) {
  const staleCount = data.regime.symbols.filter((item) => item.stale).length;
  return (
    <OpsPanel
      title="Regime Freshness"
      eyebrow="Persisted-first symbol state"
      action={<OpsStatusPill status={staleCount === 0 ? "healthy" : staleCount === data.regime.symbols.length ? "missing" : "stale"} />}
      className="xl:col-span-2"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] table-fixed text-left">
          <thead className="border-b border-[var(--color-border-subtle)] text-[9px] uppercase text-[var(--color-text-dim)]">
            <tr>
              <th className="w-[120px] px-4 py-2 font-normal">Symbol</th>
              <th className="w-[150px] px-3 py-2 font-normal">Regime</th>
              <th className="w-[100px] px-3 py-2 font-normal">Reliability</th>
              <th className="w-[170px] px-3 py-2 font-normal">Timestamp</th>
              <th className="w-[170px] px-3 py-2 font-normal">Source</th>
              <th className="w-[90px] px-3 py-2 font-normal">Freshness</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-subtle)]">
            {data.regime.symbols.map((item) => (
              <tr key={item.symbol} className="h-[48px] text-[9px] text-[var(--color-text-secondary)]">
                <td className="px-4 py-2 font-mono text-[var(--color-text-primary)]">{item.symbol}</td>
                <td className="px-3 py-2 font-mono">{item.regime ?? "No state"}</td>
                <td className="px-3 py-2 font-mono">{item.reliability === null ? "-" : item.reliability.toFixed(2)}</td>
                <td className="px-3 py-2">{formatTimestamp(item.timestamp)}</td>
                <td className="px-3 py-2 font-mono">{item.source}</td>
                <td className="px-3 py-2"><OpsStatusPill status={item.source === "empty" ? "missing" : item.stale ? "stale" : "healthy"} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </OpsPanel>
  );
}
