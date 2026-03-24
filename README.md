# oh-my-claudeagent

Turn Claude Code into a multi-agent system. Specialist agents handle planning, execution, code review, debugging, and research — with persistence modes, parallel execution, and natural language activation.

## Installation

Add the marketplace and install:

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

### Update

```bash
/plugin marketplace update omca
```

### Uninstall

```bash
/plugin uninstall oh-my-claudeagent@omca
```

## Quick Start

After installing, run `/oh-my-claudeagent:omca-setup` to configure your environment and
verify dependencies. Then try:

- Type "create plan for [your task]" to start the planning pipeline
- Type "ralph don't stop" to activate persistence mode (keeps working until done)
- Type "ultrawork" to run independent tasks across up to 5 parallel agents
- Run `/oh-my-claudeagent:start-work` after a plan is ready to begin execution

## What You Get

Specialist agents (sisyphus, atlas, prometheus, metis, momus, oracle, sisyphus-junior,
explore, librarian, hephaestus, multimodal-looker, socrates, triage), skills invokable via
slash commands or keyword triggers, 3 bundled MCP servers (omca: structural search +
state tracking, grep.app public code search, context7 library docs),
and hook commands for session persistence, context injection, and auto-approval.

## Requirements

- Claude Code CLI
- `jq`
- `uv`
- `python3` 3.10+
- `ast-grep` CLI (`ast-grep` or `sg`)

## Documentation

- `OMCA.md` — Complete guide: agents, skills, workflows, MCP tools, runtime state,
  troubleshooting, and architecture
- `CLAUDE.md` — Contributor internals: hook map, cross-file patterns, adding components,
  ADRs (auto-generated locally, not tracked in git)

## Acknowledgments

Based on [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) by [@code-yeongyu](https://github.com/code-yeongyu).

## License

MIT
