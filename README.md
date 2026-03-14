# oh-my-claudeagent

Multi-agent orchestration plugin for Claude Code. Delegation-first architecture with Greek mythology naming, persistence modes, and parallel execution.

---

## Installation

### From Marketplace

Add the marketplace and install the plugin:

```bash
/plugin marketplace add UtsavBalar1231/oh-my-claudeagent
/plugin install oh-my-claudeagent@omca
```

Or via CLI:

```bash
claude plugin marketplace add UtsavBalar1231/oh-my-claudeagent
claude plugin install oh-my-claudeagent@omca
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

`/oh-my-claudeagent:omca-setup` helps with the local `~/.claude/CLAUDE.md` block, dependency checks, and setup inspection. It does not run marketplace install commands for the user or enforce org-wide Claude Code policy settings.

### Enterprise Rollout

For centrally managed deployments, keep plugin enrollment and policy in Claude Code settings and treat `omca-setup` as a local helper rather than an installer.

- `strictKnownMarketplaces` limits installs to marketplaces your admins explicitly approve.
- `blockedMarketplaces` denies specific marketplace sources even if a user or project adds them elsewhere.
- `allowManagedHooksOnly` restricts hook execution to entries defined in managed settings.
- `allowManagedPermissionRulesOnly` restricts allow/deny permission rules to managed settings.
- `allowManagedMcpServersOnly` restricts MCP server definitions to managed settings.

Those keys belong in managed settings when you need non-overridable enterprise policy. Project `.claude/settings.json` is still the right place for shared defaults like `extraKnownMarketplaces` and `enabledPlugins`.

Marketplace installs run from `~/.claude/plugins/cache`. The bundled `ast-grep` MCP launcher bootstraps a plugin-local `.venv` inside the active plugin root on first use, so enterprise packaging needs to allow that cache copy to persist and create its runtime environment.

See `docs/audit/enterprise-policy-guide.md` for the rollout split between managed settings, project settings, and the local `omca-setup` helper.

### Development and Packaging Notes

- `claude --plugin-dir ./path/to/plugin` loads a local checkout in place for the current session. It accepts one path per flag; use repeated `--plugin-dir` flags for multiple directories. Marketplace installs copy the plugin into `~/.claude/plugins/cache`.
- Because marketplace installs run from that cached copy, packaged plugin files must not rely on sibling or parent-directory references outside the plugin root.
- The bundled `ast-grep` MCP launcher creates its `.venv` inside the active plugin root, which means local `--plugin-dir` runs and cached marketplace installs each maintain their own bootstrap environment.
- For contributors maintaining `.claude-plugin/marketplace.json`, plugin sources can be `./`-prefixed local paths or structured GitHub objects (`{"source": "github", "repo": "owner/repo"}`). This repo uses the GitHub source format because the plugin IS the marketplace root (self-referencing `"./"` fails schema validation).
- If both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` declare a version, Claude Code uses the manifest version from `plugin.json` as the installed version authority. Keep the two values in sync.

### Staying Up to Date

```bash
/plugin marketplace update omca
```

### Uninstall

```bash
/plugin uninstall oh-my-claudeagent@omca
```

---

## Requirements

- Claude Code CLI
- `jq` — hook scripts parse JSON payloads with it
- `python3` (3.10+) — required by the ast-grep MCP launcher, which bootstraps a plugin-local `.venv` on first run
- `ast-grep` CLI (`ast-grep` or `sg`) — required for structural code-search tools exposed by the ast-grep MCP server

---

## What This Does

oh-my-claudeagent turns Claude Code into a multi-agent system. A master orchestrator (Sisyphus) delegates to specialists based on task type. Every agent has a Greek mythology name and a defined role.

### Agents

| Agent | Role | Model |
|-------|------|-------|
| **sisyphus** | Master orchestrator | opus |
| **sisyphus-junior** | Focused task executor | sonnet |
| **prometheus** | Strategic planner (interview → plan) | opus |
| **metis** | Pre-planning analyst, requirement gaps | opus |
| **momus** | Plan reviewer and critic | opus |
| **oracle** | Architecture advisor, read-only verifier | opus |
| **atlas** | Todo-list orchestrator | opus |
| **explore** | Codebase search specialist | sonnet |
| **librarian** | External research, SDK/API docs | sonnet |
| **hephaestus** | Build and toolchain fixer | sonnet |
| **multimodal-looker** | Vision, PDF, and image analysis | sonnet |

Use `Agent(model="haiku")` or `Agent(model="opus")` to override any agent's default model for cost or quality tuning.

---

## Skills (Slash Commands)

Invoke with `/oh-my-claudeagent:<skill>` in any Claude Code session.

| Skill | What it does |
|-------|-------------|
| `ralph` | Persistence mode — loops until verified complete |
| `ultrawork` | Maximum parallel execution across independent tasks |
| `refactor` | Intelligent refactoring with zero-regression verification |
| `init-deep` | Generate hierarchical `AGENTS.md` files across codebase |
| `start-work` | Execute a plan generated by prometheus |
| `cancel-ralph` | Cancel an active ralph persistence loop |
| `stop-continuation` | Stop all continuation mechanisms (ralph, boulder state) |
| `handoff` | Create context summary for seamless new-session continuation |
| `frontend-ui-ux` | Production-quality UI/UX design patterns |
| `git-master` | Advanced git operations, atomic commits, clean history |
| `playwright` | Browser automation via MCP |
| `omca-setup` | Update `~/.claude/CLAUDE.md`, check deps, and inspect setup state |
| `dev-browser` | Browser with persistent state for dev workflows |
| `atlas` | Execute work plans via Atlas orchestrator |
| `metis` | Pre-planning analysis and gap detection |
| `prometheus-plan` | Strategic planning via Prometheus interview workflow |
| `hephaestus` | Fix build failures, type errors, toolchain issues |
| `sisyphus-orchestrate` | Master orchestration via Sisyphus |

---

## Keyword Activation

Type these anywhere in a prompt to auto-activate modes without the slash command:

| Keyword | Activates |
|---------|-----------|
| `ralph`, `don't stop`, `must complete` | Ralph persistence mode |
| `ulw`, `ultrawork` | Parallel execution |
| `handoff`, `context is getting long` | Session handoff summary |
| `stop continuation`, `pause automation` | Stop all continuation mechanisms |
| `run atlas`, `atlas execute` | Atlas plan execution |
| `run metis`, `metis analyze`, `pre-plan` | Metis pre-planning analysis |
| `run prometheus`, `create plan` | Prometheus strategic planning |
| `fix build`, `build broken` | Hephaestus build fixing |
| `run sisyphus`, `orchestrate this` | Sisyphus master orchestration |

---

## Runtime State

Plugin-managed state lives in `.omca/` in your project directory (add it to `.gitignore`). Core files are created automatically; mode-specific files appear only when those workflows run:

```
.omca/
├── state/
│   ├── session.json
│   ├── agent-usage.json
│   ├── injected-context-dirs.json
│   ├── subagents.json
│   ├── compaction-context.md
│   ├── verification-evidence.json
│   ├── ralph-state.json
│   ├── ultrawork-state.json
│   ├── boulder.json
│   ├── team-state.json
│   └── worktrees/
├── plans/          # Plan artifacts used by planning/execution skills
└── logs/
    ├── sessions.jsonl
    ├── edits.jsonl
    ├── instructions-loaded.jsonl
    ├── subagents.jsonl
    ├── errors.jsonl
    ├── agent-spawns.log
    └── config-changes.log
```

---

## Architecture

- **Markdown-first, no TypeScript build step** — agents are `.md` files, skills are `SKILL.md` files, and hook/runtime wiring is shell+JSON.
- **Owned runtime bootstrap** — the bundled ast-grep MCP launcher creates and reuses a plugin-local `.venv` for Python dependencies.
- **Hook-driven** — Hook events in `hooks/hooks.json` drive all automation.
- **MCP server** — `servers/ast-grep-server.py` provides structural code search via the `sg` CLI.
- **Plugin manifest** — `.claude-plugin/plugin.json` and `marketplace.json` declare metadata for marketplace distribution and discovery. Plugin sources use structured GitHub objects or `./`-relative paths. Installed plugins resolve from the cache copy, not the original checkout.

---

## License

MIT
