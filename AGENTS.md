# AGENTS.md

## Purpose

This repository uses multiple AI agents. This file is the shared operating contract so agents do not drift from the architecture, coding standards, or current project direction.

Agents must read this file before making changes.

## Agent Roles

### ChatGPT / Codex

Primary role: technical reviewer, architecture auditor, reasoning layer, test planner, and implementation validator.

Use for:
- Reviewing pull requests and diffs
- Finding architectural drift
- Validating data flow
- Debugging failed builds or deployments
- Writing implementation plans for other agents
- Producing final engineering audits

Do not use Codex as the only implementation authority for large multi-file changes unless the task is already scoped by an issue.

### Claude Code

Primary role: implementation agent.

Use for:
- Multi-file edits
- Refactors
- Feature implementation
- Wiring existing modules together
- Creating PRs from GitHub Issues
- Applying known architecture rules from this file and `CLAUDE.md`

Claude must avoid changing architecture unless the issue explicitly asks for it.

### Human Owner

Primary role: product owner, final decision maker, and merge authority.

The human owner approves:
- Architecture changes
- Production deployments
- Database schema changes
- Security-sensitive changes
- Trading logic changes
- Billing/payment/infrastructure changes

## Source of Truth Order

When instructions conflict, use this priority:

1. Explicit GitHub Issue or PR instructions
2. `AGENTS.md`
3. `CLAUDE.md`
4. Existing code patterns
5. README / docs
6. Agent assumptions

Agents must not invent architecture when the repo already has a pattern.

## Required Workflow

All non-trivial changes should follow this flow:

1. Create or reference a GitHub Issue.
2. Define the goal, constraints, and acceptance criteria.
3. Claude implements on a branch.
4. Codex/ChatGPT reviews the PR.
5. Human owner approves and merges.
6. Vercel/GitHub Actions deployment logs are checked.
7. Any follow-up work becomes a new issue.

## Issue Template for AI Work

Use this structure for implementation issues:

```md
## Goal
What should be built, fixed, or reviewed?

## Context
Relevant files, routes, services, agents, APIs, or database tables.

## Current Behavior
What happens today?

## Desired Behavior
What should happen after this change?

## Constraints
- Do not change unrelated files.
- Do not rewrite architecture unless explicitly requested.
- Preserve existing public APIs unless specified.
- Avoid introducing new dependencies unless justified.

## Acceptance Criteria
- Build passes.
- Tests pass or a test plan is provided.
- Existing behavior is not regressed.
- Changes are documented where needed.

## AI Assignment
Claude:
- Implementation
- Branch creation
- PR creation

Codex / ChatGPT:
- Architecture review
- Edge-case review
- Testing review
- Deployment review
```

## Pull Request Rules

Every PR should include:

```md
## Summary
Short explanation of what changed.

## Files Changed
Important files and why they changed.

## Risk Level
Low / Medium / High

## Test Plan
Commands run and results.

## Architecture Impact
Does this change architecture, data flow, schema, auth, deployment, or trading logic?

## Follow-Up
Anything intentionally deferred.
```

## Non-Negotiable Rules

- Do not remove working behavior without explaining why.
- Do not rename core files/functions unless the issue asks for it.
- Do not hide failing tests.
- Do not silently change environment variable names.
- Do not hardcode secrets, API keys, tokens, credentials, or private URLs.
- Do not change production database schema without a migration plan.
- Do not make speculative trading logic changes without an explicit issue.
- Do not make Vercel deployment changes without documenting expected behavior.

## Code Quality Standards

Agents should prefer:

- Small, focused commits
- Type-safe changes
- Existing project patterns
- Clear function names
- Minimal dependencies
- Explicit error handling
- Deterministic behavior
- Logs that help debug production issues without exposing secrets

Agents should avoid:

- Broad rewrites
- Style-only churn
- Unnecessary abstraction
- New frameworks unless approved
- Magic numbers without comments
- Duplicating business logic

## Testing Standards

Before marking work complete, provide one of:

- Commands actually run
- Tests added
- Manual test steps
- Reason tests could not be run

Minimum expected checks for Next.js projects:

```bash
pnpm lint
pnpm typecheck
pnpm build
```

If scripts differ, use the repo’s actual package scripts.

## Deployment Review

After deployment, check:

- Vercel build status
- Build logs
- Runtime errors
- Environment variable issues
- Route availability
- API behavior
- Auth/session behavior if applicable

## Security Rules

Never commit:

- `.env`
- `.env.local`
- API keys
- Database URLs
- Supabase service role keys
- Anthropic/OpenAI keys
- GitHub tokens
- Vercel tokens
- Customer data
- Private client details

Use example files:

- `.env.example`
- `.mcp.example.json`

## Communication Rules

When reporting back, agents should use this structure:

```md
## What I changed

## Why I changed it

## How I tested it

## Risks / Unknowns

## Recommended next step
```

## Anti-Drift Rule

If an agent notices the current task conflicts with this file, it must stop and ask for confirmation before proceeding.

If an agent discovers missing architecture documentation, it should propose a doc update instead of relying on memory.
