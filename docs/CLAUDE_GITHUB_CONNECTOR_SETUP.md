# Claude / Anthropic GitHub Connector Setup

## Recommended Options

There are two practical ways to connect Claude to GitHub-backed work.

## Option A — Claude Code GitHub Actions

Best for:
- Having Claude respond to GitHub Issues and PR comments
- Asking `@claude` to implement a task
- Letting Claude create PRs
- Keeping work inside GitHub

Basic setup:

1. Open Claude Code in your repo.
2. Run:

```bash
/install-github-app
```

3. Follow the installer.
4. Add the required GitHub secrets.
5. Test from a GitHub Issue or PR comment:

```md
@claude please review this issue and open a PR.

Follow AGENTS.md and CLAUDE.md.
```

Manual setup usually requires:

- Installing the Claude GitHub App
- Adding `ANTHROPIC_API_KEY` to GitHub repository secrets
- Adding a Claude workflow under `.github/workflows/`

## Option B — Claude Code MCP GitHub Connector

Best for:
- Local Claude Code sessions
- Allowing Claude to query GitHub from your terminal
- Working across repos without copying/pasting context

### 1. Create a Fine-Grained GitHub Token

Create a GitHub personal access token with access only to the repos Claude needs.

Recommended permissions:

- Contents: read/write
- Issues: read/write
- Pull requests: read/write
- Metadata: read-only

Avoid full-account classic tokens if possible.

### 2. Store the Token Locally

Do not commit this token.

Mac/Linux:

```bash
export GITHUB_PAT="github_pat_xxx"
```

Windows PowerShell:

```powershell
setx GITHUB_PAT "github_pat_xxx"
```

Restart your terminal after using `setx`.

### 3. Add GitHub MCP to Claude Code

Recommended local command:

```bash
claude mcp add --transport http github https://api.githubcopilot.com/mcp/ \
  --header "Authorization: Bearer $GITHUB_PAT"
```

Then verify:

```bash
claude mcp list
```

Inside Claude Code, run:

```text
/mcp
```

### 4. Project-Scoped Example

Use `.mcp.example.json` as a safe template.

Do not commit real tokens.

Copy it locally if needed:

```bash
cp .mcp.example.json .mcp.json
```

Then ensure `.mcp.json` uses environment variable expansion, not hardcoded credentials.

## Recommended Security Model

Use least privilege:

- Only selected repositories
- Fine-grained token
- No organization-wide access unless needed
- Rotate token periodically
- Revoke token if exposed
- Never commit `.mcp.json` with real secrets

## Suggested `.gitignore`

Add:

```gitignore
.mcp.json
.env
.env.local
```

Keep:

```text
.mcp.example.json
```

## Test Prompts

After setup, test Claude Code with:

```md
List open issues in this repository and summarize which are ready for implementation.
```

```md
Review the latest PR and identify architecture drift against AGENTS.md.
```

```md
Create an issue for improving the AI workflow documentation.
```

## Recommended Operating Model

Use GitHub Issues as the shared memory.

Claude should implement.
Codex / ChatGPT should review.
The human owner should approve and merge.
