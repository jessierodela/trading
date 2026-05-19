# AI Engineering Workflow

## Goal

This repo uses GitHub as the shared source of truth between the human owner, Claude Code, Codex, ChatGPT, GitHub Actions, and Vercel.

The goal is to prevent scattered context across chats.

## Workflow

```text
Human owner
  ↓
GitHub Issue
  ↓
Claude Code implementation
  ↓
Pull Request
  ↓
Codex / ChatGPT review
  ↓
Human approval
  ↓
Merge
  ↓
Vercel deployment
  ↓
Deployment log review
```

## How to Use Claude

Use Claude for implementation.

Example issue comment:

```md
@claude please implement this issue.

Follow AGENTS.md and CLAUDE.md.

Constraints:
- Keep the change focused.
- Do not modify unrelated files.
- Open a PR when complete.
- Include test results in the PR body.
```

## How to Use Codex / ChatGPT

Use Codex or ChatGPT for review.

Example prompt:

```md
Review this PR against AGENTS.md and CODEX.md.

Focus on:
- Architecture drift
- Runtime bugs
- Type safety
- Missing tests
- Vercel deployment risk
- Security issues

Return:
- Verdict
- Blocking issues
- Non-blocking suggestions
- Recommended next step
```

## Issue Labels

Recommended labels:

- `ai:ready`
- `ai:claude`
- `ai:codex-review`
- `risk:low`
- `risk:medium`
- `risk:high`
- `needs-human-approval`
- `deployment-review`

## Branch Rules

AI-generated work should use:

```text
ai/<task-name>
```

## Merge Rules

Do not merge until:

- PR matches issue scope
- Build passes
- Typecheck passes when available
- Deployment impact is understood
- Human owner approves

## Deployment Review Prompt

After Vercel deployment:

```md
Review the latest Vercel deployment for this PR.

Check:
- Build errors
- Runtime errors
- Missing environment variables
- Route failures
- Unexpected framework/package warnings

Return:
- Deployment verdict
- Blocking issues
- Recommended fix
```

## Context Preservation Rules

Do not preserve context in chat only.

Important decisions must be written to one of:

- GitHub Issue
- GitHub PR
- README
- docs file
- AGENTS.md
- CLAUDE.md
- CODEX.md

## When to Update AGENTS.md

Update `AGENTS.md` when:

- Architecture changes
- New agents are added
- New source-of-truth rules are created
- A repeated drift issue appears
- New deployment or database rules are established
