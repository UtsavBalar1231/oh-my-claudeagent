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

Add to your project's `.claude/settings.json` so team members get the plugin automatically:

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

- Claude Code CLI
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

## Documentation

- `OMCA.md` — Complete guide: agents, skills, workflows, MCP tools, runtime state, troubleshooting
- `CLAUDE.md` — Contributor internals: hook map, cross-file patterns, adding components
- [`docs/reference/known-issues.md`](docs/reference/known-issues.md): live limitations and workarounds
- [`docs/reference/configuration.md`](docs/reference/configuration.md): every user-facing setting, env var, and settings.json block

## Acknowledgments

Based on [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) by [@code-yeongyu](https://github.com/code-yeongyu).

## License

MIT
