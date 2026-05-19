# CLAUDE.md

## Purpose

This file gives Claude Code project-specific working instructions.

Claude must read this file before implementing changes.

## Claude's Role

Claude is the implementation agent.

Claude should:
- Execute scoped GitHub Issues
- Make focused multi-file changes
- Follow existing code patterns
- Create branches and PRs
- Keep changes reviewable
- Ask before changing architecture

Claude should not:
- Make broad rewrites without approval
- Change architecture by assumption
- Modify secrets or environment values directly
- Introduce new dependencies without justification
- Change production database schema without an explicit issue
- Merge its own PRs

## Default Implementation Behavior

Before editing:

1. Read the issue or user request.
2. Read `AGENTS.md`.
3. Identify relevant files.
4. Explain the planned file changes.
5. Make the smallest correct change.
6. Run available checks.
7. Summarize what changed.

## Branch Naming

Use this format:

```text
ai/<short-task-name>
```

Examples:

```text
ai/regime-detector-pipeline
ai/fix-contact-form-resend
ai/vercel-build-cleanup
ai/crm-followup-api
```

## Commit Message Style

Use concise commit messages:

```text
feat: wire regime detector into confluence flow
fix: resolve contact form submission state
docs: add AI agent workflow instructions
chore: clean up unused deployment config
```

## Pull Request Expectations

Every PR should include:

```md
## Summary
- What changed
- Why it changed

## Test Plan
- [ ] lint
- [ ] typecheck
- [ ] build
- [ ] manual route/API test

## Risk
Low / Medium / High

## Notes for Reviewer
Anything the reviewer should focus on.
```

## Code Change Boundaries

Claude should avoid changing unrelated files.

If Claude finds a separate issue, create a follow-up item instead of bundling it into the same PR.

## Dependency Rules

Do not add dependencies unless:

1. The issue explicitly requests it, or
2. The dependency removes significant complexity, and
3. The PR explains why the dependency is needed.

## Environment Variables

Never invent new environment variables without updating:

- `.env.example`
- README or setup docs
- Vercel environment notes if relevant

Never commit real secret values.

## Database Rules

For Supabase/Postgres projects:

- Do not change schema without a migration.
- Do not write destructive migrations without explicit approval.
- Prefer additive migrations.
- Document rollback considerations.
- Keep service role keys server-side only.

## API Route Rules

For Next.js API routes:

- Validate inputs.
- Return useful error responses.
- Do not expose stack traces to clients.
- Keep server-only secrets server-side.
- Use existing response patterns when available.

## UI Rules

For frontend changes:

- Preserve responsive behavior.
- Avoid visual regressions.
- Use existing Tailwind/component patterns.
- Do not redesign unrelated sections.
- Keep accessibility in mind.

## Testing Rules

Run the repo’s available checks.

Common commands:

```bash
pnpm lint
pnpm typecheck
pnpm build
```

If a command is unavailable, say so in the PR.

## Final Response Format

When Claude finishes work, respond with:

```md
## Completed
What was implemented.

## Files Changed
Files and purpose.

## Tests
Commands run and results.

## Risks
Anything that needs review.

## Next Step
Recommended next action.
```

## Stop Conditions

Stop and ask for confirmation if:

- The requested change conflicts with `AGENTS.md`
- The implementation requires a schema change not mentioned in the issue
- The change requires new secrets
- The task requires deleting or replacing major architecture
- Tests fail for reasons unrelated to the current task
