# P0 Stabilization — What Shipped

Ten files changed (one new). All four code items in the plan's Priority 0
are implemented. Item 0.5 was scoped down deliberately — details below.

## Validation

- `npx tsc --noEmit` — clean
- `npm run build` — clean (Google Fonts dependency removed)
- `npm audit` — 1 critical / 2 high resolved; 2 moderate remain (postcss
  XSS via untrusted CSS injection, not reachable in this codebase)
- Inline behavioural smoke test — 10/10 assertions pass

## Files

### Modified
1. `components/agents/LiveAgentGrid.tsx` — A4/A5 metadata swapped so UI
   matches runtime (A4 = Volatility Arbiter, A5 = Mean Reversion)
2. `lib/confluence/scoreSignals.ts` — new `RegimeContext` parameter,
   regime gating (block on NEWS_SHOCK / low reliability, raise threshold
   in CHOP, soften verdicts on TREND_*/score conflict), defensive A6 skip
3. `lib/confluence/confluenceEngine.ts` — new signature
   `runConfluenceEngine(tradingSignals, regimeMap)`, regime-derived tags,
   regime surfaced in GPT narrative input
4. `app/api/cache/refresh/route.ts` — filters A6 out of confluence input,
   passes regime map separately; trading stats now derive from
   `tradingSignals` (no need to filter again)
5. `app/api/signals/route.ts` — fixed unused-but-wrong `computeStats` to
   match canonical A6 filtering (latent inconsistency)
6. `app/api/regime/[symbol]/route.ts` — uses shared `permissionMap`
7. `app/api/regime/refresh/route.ts` — uses shared `permissionMap` (now
   enforces reliability floor it previously lacked)
8. `app/globals.css` — `--font-mono` defined here using system mono stack
9. `app/layout.tsx` — `next/font/google` import removed
10. `package-lock.json` — updated by `npm audit fix` (next 15.1.9 → 15.5.18)

### New
- `lib/regime/permissionMap.ts` — single source of truth for regime →
  trade permission. Documents the previous divergence between the two
  routes (every regime row differed) and which numbers were chosen as
  canonical (refresh route's, since that's what the Markov bot has been
  receiving in production).

## What was NOT done

### Next.js 16 major upgrade
The plan's 0.5 suggested `npm install next@latest` (currently 16.2.6).
`npm audit fix` alone resolved the critical Next.js advisory without a
major version bump, so I stopped there. The 2 remaining moderate
postcss XSS advisories are not reachable in this codebase. Upgrading to
Next 16 should be a deliberate, gated step — recommend doing it after
Phase 1 finishes and before Phase 2's DB layer, so any breaking changes
surface before more code is built on top.

### package.json version specifiers
`package.json` still says `"next": "^15.1.9"`. The lockfile resolved to
15.5.18 via `npm audit fix`. A fresh `npm install` on another machine
should land on 15.5.18 as well (caret range), but if you want to pin
exactly: `npm install next@15.5.18 --save-exact` (and similarly for
react/react-dom).

## One decision flagged for you

In `lib/regime/permissionMap.ts` I picked the `refresh/route.ts` numbers
as canonical (size=1.25 in TREND_UP/DOWN, size=0.75 in vol regimes).
That preserves what the live Markov bot has been receiving. The
dashboard read endpoint will now produce the same (slightly less
conservative) numbers. If you'd rather the dashboard's older, more
conservative numbers be canonical, the only change is the `REGIME_GATE`
table in `lib/regime/permissionMap.ts` — there is now exactly one place
to edit. The previous divergence is documented at the top of that file.

## How regime gating now behaves

```
Reliability < 0.50         → forced no_trade
Regime = NEWS_SHOCK        → forced no_trade
Regime = CHOP              → aligned thresholds raised 1.5x (±3.0 → ±4.5)
Regime = TREND_UP + score bearish    → directional conflict, no bearish_structure verdict
Regime = TREND_DOWN + score bullish  → directional conflict, no aligned_bullish verdict
Regime = LOW_VOL / HIGH_VOL          → pass through unchanged
Regime missing (e.g. stocks)         → fail-open, no gating, tag: regime_unavailable
```

All gating decisions are exposed on the `ConfluenceResult`:
`regime`, `regimeReliability`, `regimeBlocked`, `regimeBlockReason`,
plus tags `regime_block`, `regime_directional_conflict`,
`regime_threshold_raised`, `regime_unavailable`.
