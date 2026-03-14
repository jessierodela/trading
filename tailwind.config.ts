import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ["var(--font-mono)", "Courier New", "monospace"],
      },
      colors: {
        "surface-base":  "var(--color-surface-base)",
        "surface-panel": "var(--color-surface-panel)",
        "surface-card":  "var(--color-surface-card)",
        "surface-hover": "var(--color-surface-hover)",
        "border-default":"var(--color-border-default)",
        "border-subtle": "var(--color-border-subtle)",
        "accent-green":  "var(--color-accent-green)",
        "accent-blue":   "var(--color-accent-blue)",
        "accent-amber":  "var(--color-accent-amber)",
        "accent-red":    "var(--color-accent-red)",
        "text-primary":  "var(--color-text-primary)",
        "text-secondary":"var(--color-text-secondary)",
        "text-muted":    "var(--color-text-muted)",
        "text-dim":      "var(--color-text-dim)",
      },
      animation: {
        "pulse-dot":   "pulse-dot 2.2s ease-in-out infinite",
        "pulse-amber": "pulse-amber 1.5s ease-in-out infinite",
        "fade-in":     "fade-slide-in 0.25s ease forwards",
      },
    },
  },
  plugins: [],
};

export default config;
