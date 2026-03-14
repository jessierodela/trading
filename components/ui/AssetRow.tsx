import type { WatchlistAsset } from "@/types/market";

interface AssetRowProps {
  asset: WatchlistAsset;
  isActive: boolean;
  onClick: () => void;
}

export function AssetRow({ asset, isActive, onClick }: AssetRowProps) {
  return (
    <div
      onClick={onClick}
      className={`
        px-[14px] py-[9px] border-b border-[var(--color-border-subtle)]
        flex justify-between items-center cursor-pointer transition-all duration-150
        hover:bg-[var(--color-surface-hover)]
        ${isActive
          ? "bg-[var(--color-surface-card)] border-l-[1.5px] border-l-[var(--color-text-secondary)] pl-[12px]"
          : "border-l-[1.5px] border-l-transparent"
        }
      `}
    >
      <div>
        <div className={`text-[11px] font-medium tracking-tight ${isActive ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-secondary)]"}`}>
          {asset.symbol}
        </div>
        <div className="text-[9px] text-[var(--color-text-dim)] mt-[1px]">{asset.name}</div>
      </div>
      <div className="text-right">
        <div className={`text-[11px] ${isActive ? "text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)]"}`}>
          {asset.price}
        </div>
        <div className={`text-[9px] mt-[1px] ${asset.changeUp ? "text-[var(--color-accent-green)]" : "text-[var(--color-accent-red)]"}`}>
          {asset.change}
        </div>
      </div>
    </div>
  );
}
