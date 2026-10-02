# oh-my-claudeagent

Multi-agent system for Claude Code. Specialist agents for planning, execution, review, debugging, research — with persistence, parallel execution, and natural language activation.

## Installation

```bash
claude plugin marketplace add UtsavBalar1231/oh-my-claudeagent
claude plugin install oh-my-claudeagent@omca
```

Or from inside a Claude Code session:

```
/plugin marketplace add UtsavBalar1231/oh-my-claudeagent
/plugin install oh-my-claudeagent@omca
```

### Team Setup

Add to your project's `.claude/settings.json` so team members get the plugin automatically in local sessions (cloud sessions load only plugins synced from claude.ai):

```json
{
  "extraKnownMarketplaces": {
    "omca": {
      "source": {
        "source": "github",
        "repo": "UtsavBalar1231/oh-my-claudeagent"
      }
    }
  },
  "enabledPlugins": {
    "oh-my-claudeagent@omca": true
  }
}
```

For GitHub Enterprise Server, use full git URLs in the source:

```json
{
  "extraKnownMarketplaces": {
    "omca": {
      "source": {
        "source": "git",
        "url": "git@github.example.com:org/oh-my-claudeagent.git"
      }
    }
  }
}
```

### Update

```bash
/plugin marketplace update omca
```

### Local cache rebuild

Rebuild the locally-installed plugin cache from your dev tree:

```bash
bash scripts/package-plugin.sh ~/.claude/plugins/cache/omca/oh-my-claudeagent/$(jq -r .version .claude-plugin/plugin.json)/
```

Use `--dry-run` first to preview the file list. The script excludes dev artifacts (`.omca/`, `.mypy_cache/`, `UPGRADE.md`, `tests/`, etc.) that should not ship.

### Uninstall

```bash
/plugin uninstall oh-my-claudeagent@omca
```

## Quick Start

Run `/oh-my-claudeagent:omca-setup` to configure and verify dependencies. Then:

- "create plan for [your task]" — planning pipeline
- `/oh-my-claudeagent:start-work` — execute a ready plan
- `/loop 10m /oh-my-claudeagent:start-work` — re-run on a timer via native `/loop` (lightweight, not a verified persistence loop)

## What You Get

Specialist agents, skills via slash commands or keyword triggers, bundled MCP servers
(omca: structural search + state, grep.app: public code search, context7: library docs),
hooks for persistence, context injection, and auto-approval. Comment conventions for
Bash, Python, kernel C and headers, Rust, and Go plus a Markdown prose convention ship in
`rules/` and are injected when you edit a matching file; override or disable any of them
from your project's `.omca/rules/`.

### Heads-up — `worktree.baseRef` and unpushed commits

Worktree-isolated agents can silently miss your unpushed local commits. See
[Known Issues](docs/reference/known-issues.md#worktreebaseref-hides-unpushed-commits-by-default)
for the trap and the one-setting workaround.

## Requirements

- Claude Code CLI v2.1.271 or later (older clients cannot load a plugin whose `userConfig` declares `options`)
- `jq`
- `uv`
- `python3` 3.10+
- `ast-grep` CLI (`ast-grep` or `sg`)

### For LLM agents

If you're an agent installing this plugin on someone's behalf, paste this after
install:

```
Run /oh-my-claudeagent:omca-setup, then verify: (1) it reports dependencies OK
(jq, uv, python3, ast-grep all found), (2) it confirms ~/.claude/settings.json
was updated with the orchestration block, (3) it prints a final summary with no
FAIL lines. If any check fails, run /oh-my-claudeagent:omca-setup --doctor and
report the output. That flag is this skill's own read-only report, scoped to OMCA
configuration; it changes nothing. The platform's separate built-in /doctor
(alias /checkup) is the fix-capable one.
```

## OpenCode V2

The `opencode/` directory is an adapter that loads OMCA's specialists, skills, MCP server
and guardrails into OpenCode. It is tested against OpenCode 2.0.18. The entry point is
`opencode/index.ts`, exported from `package.json`.

### Install

Add the plugin to your OpenCode config, installed from git:

```jsonc
{
  "plugins": [
    {
      "package": "oh-my-claudeagent@git+https://github.com/UtsavBalar1231/oh-my-claudeagent.git",
      "options": { "models": { "opus": "anthropic/claude-opus-5-5", "fable": "anthropic/claude-fable-5-1" } }
    }
  ]
}
```

To load a local checkout instead, point at its `opencode/` directory:

```jsonc
{
  "plugins": ["/path/to/oh-my-claudeagent/opencode"]
}
```

`options.models` maps OMCA's `opus`, `sonnet` and `fable` tiers to OpenCode model ids, in
`provider/model` form with an optional `#variant`. Without it, every `omca-*` subagent
inherits the parent session's model. To override one agent, set `agents.omca-<name>.model`
in your own config, which merges over the plugin's agent.

Prerequisites: `uv`, ast-grep (`ast-grep` or `sg`), `bash` 4.3+ and `jq`.

### What ships

- Subagents: `omca-explore`, `omca-oracle`, `omca-librarian`, `omca-multimodal-looker`,
  `omca-metis`, `omca-momus`, `omca-hephaestus`, `omca-executor`.
- Skills: `omca-debugging`, `omca-remove-ai-slops`, `omca-refactor`, `omca-git-master`,
  `omca-handoff`. All are slash-invocable. `/omca-handoff` is not advertised to the
  model, so it runs when you type it.
- Commands: `/omca-metis`, `/omca-momus`, `/omca-hephaestus`. Each asks the primary agent
  to launch that subagent.
- MCP: the `omca` server with the evidence, notepad, AST and `file_read` tools, exposed as
  `omca_<tool>` (for example `omca_evidence_log`). It is registered only when `uv` and
  ast-grep are on PATH, and its first launch runs `uv sync`.
- Guardrails: `permission-filter.sh`, `git-destructive-deny.sh` and `comment-checker.sh`
  run on model and user shell commands and on file edits, and block the call on deny.
  Comment enforcement blocks only with `OMCA_COMMENT_GATE=deny` set. A blocked `!` shell
  command shows as a failed command without the reason; the reason goes to the OpenCode
  server log. `comment-checker.sh` needs `bash` 4.3+ and `jq`.
- Output style: OMCA's working discipline is injected into primary agents only (for
  example `build` and `plan`).

Every id carries the `omca-` prefix, so OpenCode's built-ins (`build`, `plan`, `general`,
`explore`) are untouched.

Not included: the sisyphus orchestrator, the prometheus planner, `plan` and `start-work`
with boulder plan tracking, the Stop gates (plan continuation, final verification, drift
guard), and the statusline.

### Files it creates

- `.omca/` at the workspace root: guard state and logs from the first guarded command, and
  evidence and notepads from the MCP tools.
- A Python virtual environment (`.venv`) in the installed package's `servers` directory,
  created by the first `uv sync`.

### Maintainer note

The adapter translates `agents/`, `skills/` and `output-styles/` into OpenCode prompts when
the plugin loads, so there is no build step. `bun test opencode/` checks the translated text
for Claude-only tool names and paths; an edit that introduces one fails that test. Do not
add a `build` or `prepare` script to `package.json`: npm runs those as a preparation step
when a git dependency is installed, which fails under OpenCode.

## Documentation

- `OMCA.md` — Complete guide: agents, skills, workflows, MCP tools, runtime state, troubleshooting
- `CLAUDE.md` — Contributor internals: hook map, cross-file patterns, adding components
- [`docs/reference/known-issues.md`](docs/reference/known-issues.md): live limitations and workarounds
- [`docs/reference/configuration.md`](docs/reference/configuration.md): every user-facing setting, env var, and settings.json block

## Acknowledgments

Based on [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) by [@code-yeongyu](https://github.com/code-yeongyu).

## License

MIT
