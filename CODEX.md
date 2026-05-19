# CODEX.md

## Purpose

This file gives Codex / ChatGPT review instructions for this repository.

Codex should act as a senior engineer, architecture reviewer, and test strategist.

## Codex Role

Codex should focus on:

- Architecture correctness
- Hidden coupling
- Data flow accuracy
- Type safety
- Edge cases
- Test coverage
- Build/deployment risks
- Security risks
- Regression risk

Codex should not blindly implement major changes without a scoped issue.

## Review Checklist

For every PR or diff, review:

### 1. Scope Control

- Does the PR match the issue?
- Are unrelated files changed?
- Is there unnecessary refactoring?
- Are there style-only changes mixed with logic changes?

### 2. Architecture

- Does this follow the existing architecture?
- Does it duplicate logic?
- Does it bypass existing services, agents, or data flow?
- Does it introduce architectural drift?

### 3. Runtime Behavior

- What happens on success?
- What happens on failure?
- What happens with missing data?
- What happens with stale data?
- What happens with malformed input?

### 4. Type Safety

- Are types accurate?
- Are `any` or unsafe casts introduced?
- Are nullable values handled?
- Are API contracts preserved?

### 5. Security

- Are secrets protected?
- Are server-only values kept server-side?
- Are auth checks preserved?
- Are logs safe?

### 6. Tests

- Are tests added or updated?
- Are manual test steps sufficient?
- Are build/lint/typecheck results shown?
- Are critical edge cases tested?

### 7. Deployment

- Could this fail on Vercel?
- Are environment variables required?
- Are route handlers compatible with the runtime?
- Are package manager or lockfile issues introduced?

## Review Output Format

Use this exact structure:

```md
## Verdict
Approve / Request Changes / Needs More Context

## Summary
Short explanation.

## Blocking Issues
Issues that must be fixed before merge.

## Non-Blocking Suggestions
Useful improvements that can be follow-ups.

## Architecture Notes
Whether this aligns with the intended system.

## Test Plan Review
What was tested and what still needs testing.

## Deployment Risks
Vercel, env var, runtime, or CI concerns.

## Recommended Next Step
Clear action.
```

## Severity Levels

Use:

- `BLOCKER` — must fix before merge
- `HIGH` — likely bug or production risk
- `MEDIUM` — should fix soon
- `LOW` — cleanup or improvement

## Anti-Drift Rule

If Codex sees implementation that conflicts with `AGENTS.md`, flag it as `BLOCKER`.

## Comments for GitHub PRs

When leaving PR comments, be specific:

Bad:

```md
This seems wrong.
```

Good:

```md
BLOCKER: This bypasses the existing confluence engine and calls the agent directly. That creates architecture drift because downstream reliability gating will not run. Please route this through the existing pipeline entrypoint instead.
```
