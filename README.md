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

### Uninstall

```bash
/plugin uninstall oh-my-claudeagent@omca
```

## Quick Start

Run `/oh-my-claudeagent:omca-setup` to configure and verify dependencies. Then:

- "create plan for [your task]" — planning pipeline
- "ralph don't stop" — persistence mode (works until done)
- "ultrawork" — parallel agents (up to 5)
- `/oh-my-claudeagent:start-work` — execute a ready plan

## What You Get

Specialist agents, skills via slash commands or keyword triggers, bundled MCP servers
(omca: structural search + state, grep.app: public code search, context7: library docs),
hooks for persistence, context injection, and auto-approval.

## Requirements

- Claude Code CLI
- `jq`
- `uv`
- `python3` 3.10+
- `ast-grep` CLI (`ast-grep` or `sg`)

## Documentation

- `OMCA.md` — Complete guide: agents, skills, workflows, MCP tools, runtime state, troubleshooting
- `CLAUDE.md` — Contributor internals: hook map, cross-file patterns, adding components

## Acknowledgments

Based on [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) by [@code-yeongyu](https://github.com/code-yeongyu).

## License

MIT
