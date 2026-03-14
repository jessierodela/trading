const subColorMap = {
  green: "text-[var(--color-accent-green)]",
  red:   "text-[var(--color-accent-red)]",
  muted: "text-[var(--color-text-dim)]",
};

interface MetricTileProps {
  label: string;
  value: string;
  sub?: string;
  subColor?: keyof typeof subColorMap;
  valueSize?: "default" | "sm";
}

export function MetricTile({ label, value, sub, subColor = "muted", valueSize = "default" }: MetricTileProps) {
  return (
    <div className="flex-1 bg-[var(--color-surface-panel)] px-4 py-3">
      <div className="text-[8px] text-[var(--color-text-dim)] tracking-[.12em] mb-[6px] uppercase">{label}</div>
      <div className={`font-light text-[var(--color-text-primary)] tracking-tight ${valueSize === "sm" ? "text-[16px] pt-1" : "text-[22px]"}`}>
        {value}
      </div>
      {sub && (
        <div className={`text-[9px] mt-1 ${subColorMap[subColor]}`}>{sub}</div>
      )}
    </div>
  );
}
