import { StatusDot } from "@/components/ui/StatusDot";
import type { Agent } from "@/types/agent";
import type { RegimeLabel } from "@/lib/agents/regimeDetector";

interface AgentCardProps {
  agent: Agent;
  /**
   * Optional regime context injected by LiveAgentGrid for A6.
   * When present, renders regime badges instead of standard signal/alert counts.
   */
  regimeMap?: Record<string, {
    regime:      RegimeLabel;
    reliability: number;
    emaContext:  { ema20Slope: string; ema50Above200: boolean | null };
    volContext:  { atrPct: number | null; atrRegime: string; relVol: number | null };
  }>;
}

// ─── Regime badge config ──────────────────────────────────────────────────────

const REGIME_COLORS: Record<RegimeLabel, { bg: string; text: string; border: string }> = {
  TREND_UP:   { bg: "rgba(48,209,88,0.08)",  text: "#30d158", border: "rgba(48,209,88,0.25)"  },
  TREND_DOWN: { bg: "rgba(255,69,58,0.08)",  text: "#ff453a", border: "rgba(255,69,58,0.25)"  },
  LOW_VOL:    { bg: "rgba(99,99,102,0.12)",  text: "#aeaeb2", border: "rgba(99,99,102,0.25)"  },
  HIGH_VOL:   { bg: "rgba(255,159,10,0.08)", text: "#ff9f0a", border: "rgba(255,159,10,0.25)" },
  CHOP:       { bg: "rgba(99,99,102,0.10)",  text: "#636366", border: "rgba(99,99,102,0.20)"  },
  NEWS_SHOCK: { bg: "rgba(255,69,58,0.12)",  text: "#ff453a", border: "rgba(255,69,58,0.30)"  },
};

function ReliabilityBar({ score }: { score: number }) {
  const pct  = Math.round(score * 100);
  const color = pct >= 80 ? "#30d158" : pct >= 60 ? "#ff9f0a" : "#636366";
  return (
    <div className="flex items-center gap-2 mt-[4px]">
      <div style={{ flex: 1, height: "2px", background: "#2a2a2a", borderRadius: "1px" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: "1px", transition: "width 0.4s ease" }} />
      </div>
      <span style={{ fontSize: "8px", color, fontVariantNumeric: "tabular-nums", minWidth: "28px", textAlign: "right" }}>
        {pct}%
      </span>
    </div>
  );
}

function RegimeBadge({ label }: { label: RegimeLabel }) {
  const c = REGIME_COLORS[label];
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      padding: "1px 6px",
      borderRadius: "3px",
      fontSize: "8px",
      fontWeight: 600,
      letterSpacing: "0.08em",
      background: c.bg,
      color:  c.text,
      border: `1px solid ${c.border}`,
    }}>
      {label.replace("_", " ")}
    </span>
  );
}

export function AgentCard({ agent, regimeMap }: AgentCardProps) {
  const isActive  = agent.status === "active" || agent.status === "scanning";
  const isRegime  = agent.id === "A6";

  // Extract sorted regime entries for display
  const regimeEntries = isRegime && regimeMap
    ? Object.entries(regimeMap).sort(([a], [b]) => a.localeCompare(b))
    : [];

  return (
    <div className={`
      bg-[var(--color-surface-card)] border rounded-[6px] px-[14px] py-[12px]
      transition-colors duration-150 cursor-pointer
      hover:border-[var(--color-text-muted)]
      ${isActive
        ? "border-[rgba(34,211,160,0.25)]"
        : "border-[var(--color-border-default)]"
      }
    `}>
      <div className="flex justify-between items-start mb-2">
        <span className={`text-[11px] font-semibold ${isActive ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-secondary)]"}`}>
          {agent.name}
        </span>
        <StatusDot status={agent.status} />
      </div>

      <div className="text-[9px] text-[var(--color-text-dim)] mb-2">{agent.focus}</div>

      {/* ── Regime Detector — special display ──────────────────────────── */}
      {isRegime && regimeEntries.length > 0 ? (
        <div className="flex flex-col gap-[6px]">
          {regimeEntries.map(([symbol, ctx]) => (
            <div key={symbol} style={{ borderTop: "1px solid #1c1c1c", paddingTop: "5px" }}>
              <div className="flex items-center justify-between mb-[3px]">
                <span style={{ fontSize: "9px", color: "#aeaeb2", fontWeight: 600 }}>{symbol}</span>
                <RegimeBadge label={ctx.regime} />
              </div>
              <ReliabilityBar score={ctx.reliability} />
              <div style={{ fontSize: "8px", color: "#48484a", marginTop: "3px" }}>
                EMA slope: {ctx.emaContext.ema20Slope} ·{" "}
                ATR: {ctx.volContext.atrRegime}
                {ctx.volContext.relVol != null ? ` · relVol ${ctx.volContext.relVol.toFixed(2)}x` : ""}
              </div>
            </div>
          ))}
        </div>
      ) : isRegime ? (
        /* Regime agent but no data yet */
        <div className="flex gap-3">
          <div className="text-[9px] text-[var(--color-text-muted)]">
            REGIMES <span className="text-[10px] text-[#4a8a6a]">{agent.signalCount}</span>
          </div>
          <div className="text-[9px] text-[var(--color-text-muted)]">
            HIGH CONF <span className="text-[10px] text-[#4a8a6a]">{agent.alertCount}</span>
          </div>
        </div>
      ) : (
        /* Standard agent display */
        <div className="flex gap-3">
          <div className="text-[9px] text-[var(--color-text-muted)]">
            SIGNALS{" "}
            <span className="text-[10px] text-[#4a8a6a]">{agent.signalCount}</span>
          </div>
          <div className="text-[9px] text-[var(--color-text-muted)]">
            ALERTS{" "}
            <span className="text-[10px] text-[#4a8a6a]">{agent.alertCount}</span>
          </div>
        </div>
      )}

      <div className="mt-[6px] pt-[6px] border-t border-[var(--color-border-subtle)] text-[8px] text-[var(--color-text-dim)]">
        {agent.lastAction}
      </div>
    </div>
  );
}
