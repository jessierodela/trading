"use client";

/**
 * components/IndicatorSettings.tsx
 *
 * Dashboard panel for toggling which indicators are fetched per asset.
 * Reads/writes to /api/indicator-config (persisted server-side).
 *
 * Shows:
 *  - Per-asset toggle grid (checkboxes per indicator)
 *  - Live credit count + estimated cycle time
 *  - Save button that persists the config
 */

import { useEffect, useState, useCallback } from "react";
import {
  type AssetIndicatorConfig,
  type IndicatorKey,
  INDICATOR_LABELS,
  INDICATOR_DESCRIPTIONS,
  DEFAULT_INDICATOR_CONFIG,
  totalCredits,
  estimateCycleSeconds,
} from "@/config/indicators";

const ALL_INDICATORS: IndicatorKey[] = ["rsi", "macd", "ema50", "ema200", "bb", "atr"];

// ─── Credit badge colour ──────────────────────────────────────────────────

function creditColor(credits: number): string {
  if (credits <= 20) return "text-emerald-400";
  if (credits <= 40) return "text-yellow-400";
  return "text-red-400";
}

// ─── Per-asset row ─────────────────────────────────────────────────────────

interface AssetRowProps {
  config:   AssetIndicatorConfig;
  onChange: (symbol: string, key: IndicatorKey, enabled: boolean) => void;
}

function AssetRow({ config, onChange }: AssetRowProps) {
  return (
    <div className="indicator-row">
      <div className="asset-label">
        <span className="asset-symbol">{config.symbol}</span>
        <span className="asset-credits">
          {config.enabled.length} credit{config.enabled.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="indicator-toggles">
        {ALL_INDICATORS.map((key) => {
          const active = config.enabled.includes(key);
          return (
            <button
              key={key}
              className={`indicator-pill ${active ? "active" : "inactive"}`}
              onClick={() => onChange(config.symbol, key, !active)}
              title={INDICATOR_DESCRIPTIONS[key]}
              aria-pressed={active}
            >
              {INDICATOR_LABELS[key]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

export default function IndicatorSettings() {
  const [config,  setConfig]  = useState<AssetIndicatorConfig[]>(DEFAULT_INDICATOR_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  // Load saved config from server
  useEffect(() => {
    fetch("/api/indicator-config")
      .then((r) => r.json())
      .then((data) => {
        if (data.config) setConfig(data.config);
      })
      .catch(() => {/* use default */})
      .finally(() => setLoading(false));
  }, []);

  const handleToggle = useCallback(
    (symbol: string, key: IndicatorKey, enabled: boolean) => {
      setConfig((prev) =>
        prev.map((asset) => {
          if (asset.symbol !== symbol) return asset;
          const next = enabled
            ? [...new Set([...asset.enabled, key])]
            : asset.enabled.filter((k) => k !== key);
          return { ...asset, enabled: next };
        })
      );
      setSaved(false);
    },
    []
  );

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/indicator-config", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ config }),
      });
      if (!res.ok) throw new Error(`Save failed: ${res.status}`);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setConfig(DEFAULT_INDICATOR_CONFIG);
    setSaved(false);
  };

  const credits  = totalCredits(config);
  const cycleEst = estimateCycleSeconds(config);

  if (loading) {
    return (
      <div className="settings-panel">
        <div className="loading-state">Loading indicator config…</div>
      </div>
    );
  }

  return (
    <>
      <style>{`
        .settings-panel {
          background: var(--color-background-secondary, #0f1117);
          border: 1px solid var(--color-border-secondary, #1e2433);
          border-radius: 12px;
          padding: 20px;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
        }

        .panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 18px;
          gap: 12px;
          flex-wrap: wrap;
        }

        .panel-title {
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--color-text-secondary, #8b9ab1);
        }

        .panel-stats {
          display: flex;
          gap: 16px;
          align-items: center;
          font-size: 12px;
        }

        .stat {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 1px;
        }

        .stat-value {
          font-size: 15px;
          font-weight: 700;
          line-height: 1;
        }

        .stat-label {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--color-text-tertiary, #4a5568);
        }

        .indicator-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 0;
          border-bottom: 1px solid var(--color-border-tertiary, #141824);
        }

        .indicator-row:last-of-type {
          border-bottom: none;
        }

        .asset-label {
          display: flex;
          flex-direction: column;
          min-width: 64px;
          gap: 2px;
        }

        .asset-symbol {
          font-size: 13px;
          font-weight: 700;
          color: var(--color-text-primary, #e2e8f0);
          letter-spacing: 0.04em;
        }

        .asset-credits {
          font-size: 10px;
          color: var(--color-text-tertiary, #4a5568);
        }

        .indicator-toggles {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          flex: 1;
        }

        .indicator-pill {
          font-size: 11px;
          font-weight: 500;
          padding: 4px 10px;
          border-radius: 20px;
          border: 1px solid transparent;
          cursor: pointer;
          transition: all 0.15s ease;
          font-family: inherit;
          letter-spacing: 0.03em;
        }

        .indicator-pill.active {
          background: rgba(56, 139, 253, 0.15);
          border-color: rgba(56, 139, 253, 0.4);
          color: #7ab8ff;
        }

        .indicator-pill.active:hover {
          background: rgba(56, 139, 253, 0.25);
          border-color: rgba(56, 139, 253, 0.7);
        }

        .indicator-pill.inactive {
          background: transparent;
          border-color: var(--color-border-tertiary, #1e2433);
          color: var(--color-text-tertiary, #4a5568);
        }

        .indicator-pill.inactive:hover {
          border-color: var(--color-border-secondary, #2d3748);
          color: var(--color-text-secondary, #8b9ab1);
        }

        .panel-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-top: 16px;
          padding-top: 14px;
          border-top: 1px solid var(--color-border-tertiary, #141824);
          gap: 10px;
          flex-wrap: wrap;
        }

        .footer-note {
          font-size: 11px;
          color: var(--color-text-tertiary, #4a5568);
          line-height: 1.5;
        }

        .footer-actions {
          display: flex;
          gap: 8px;
          align-items: center;
        }

        .btn {
          font-size: 12px;
          font-weight: 600;
          padding: 7px 16px;
          border-radius: 8px;
          border: 1px solid transparent;
          cursor: pointer;
          font-family: inherit;
          letter-spacing: 0.04em;
          transition: all 0.15s ease;
        }

        .btn-reset {
          background: transparent;
          border-color: var(--color-border-secondary, #1e2433);
          color: var(--color-text-secondary, #8b9ab1);
        }

        .btn-reset:hover {
          border-color: var(--color-border-primary, #2d3748);
          color: var(--color-text-primary, #e2e8f0);
        }

        .btn-save {
          background: rgba(56, 139, 253, 0.15);
          border-color: rgba(56, 139, 253, 0.4);
          color: #7ab8ff;
        }

        .btn-save:hover:not(:disabled) {
          background: rgba(56, 139, 253, 0.25);
          border-color: rgba(56, 139, 253, 0.7);
        }

        .btn-save:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .btn-saved {
          background: rgba(52, 211, 153, 0.15);
          border-color: rgba(52, 211, 153, 0.4);
          color: #6ee7b7;
        }

        .error-msg {
          font-size: 11px;
          color: #f87171;
          margin-top: 6px;
        }

        .loading-state {
          padding: 20px;
          text-align: center;
          color: var(--color-text-tertiary, #4a5568);
          font-size: 13px;
        }
      `}</style>

      <div className="settings-panel">
        <div className="panel-header">
          <span className="panel-title">Indicator Config</span>
          <div className="panel-stats">
            <div className="stat">
              <span className={`stat-value ${creditColor(credits)}`}>{credits}</span>
              <span className="stat-label">credits/cycle</span>
            </div>
            <div className="stat">
              <span className="stat-value" style={{ color: "var(--color-text-primary, #e2e8f0)" }}>
                ~{cycleEst}s
              </span>
              <span className="stat-label">cycle time</span>
            </div>
          </div>
        </div>

        {config.map((asset) => (
          <AssetRow key={asset.symbol} config={asset} onChange={handleToggle} />
        ))}

        <div className="panel-footer">
          <span className="footer-note">
            Free plan: 1 credit/sec · Changes apply on next fetch cycle
          </span>
          <div className="footer-actions">
            <button className="btn btn-reset" onClick={handleReset}>
              Reset defaults
            </button>
            <button
              className={`btn ${saved ? "btn-saved" : "btn-save"}`}
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? "Saving…" : saved ? "✓ Saved" : "Save config"}
            </button>
          </div>
        </div>

        {error && <div className="error-msg">{error}</div>}
      </div>
    </>
  );
}