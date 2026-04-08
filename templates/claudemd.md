--- omca-setup
plugin: oh-my-claudeagent
version: 1.5.0
author: UtsavBalar1231
---

# oh-my-claudeagent runtime guide

This template documents the OMCA orchestration layer for oh-my-claudeagent v1.5.0.

<operating_principles>
- Treat Claude Code as the platform owner.
- Use OMCA for specialist prompts, orchestration policy, and evidence discipline.
- Keywords like "ralph", "ultrawork", "create plan", and "handoff" are natural triggers — use them conversationally or via slash commands.
- Keep plans, memory, permissions, and scheduling on Claude-native surfaces.
- Respect managed settings as the non-overridable policy layer.
</operating_principles>

## What OMCA owns

- specialist agent prompts
- slash-skill prompts
- workflow guidance and verification rigor
- the local `omca` MCP server
- narrow wrappers such as compaction helpers and session coordination flags

## What Claude-native owns

- plan mode and native plan files
- memory scopes
- hook events and plugin schema
- permissions and sandbox policy
- teams, subagent lifecycle, `/loop`, and `/schedule`

## Entrypoints

Keywords trigger skills automatically. Slash commands are also supported:

| Need | Keyword | Slash command |
|---|---|---|
| Setup | "setup omca" | `/oh-my-claudeagent:omca-setup` |
| Plan | "create plan" | `/oh-my-claudeagent:prometheus-plan <task>` |
| Start execution | — | `/oh-my-claudeagent:start-work` |
| Must-finish mode | "ralph" / "don't stop" | `/oh-my-claudeagent:ralph <task>` |
| Parallel work | "ultrawork" / "ulw" | `/oh-my-claudeagent:ultrawork <task list>` |
| Handoff | "handoff" | `/oh-my-claudeagent:handoff` |
| Stop all modes | "stop continuation" | `/oh-my-claudeagent:stop-continuation` |

## Agent catalog

| Agent | Role |
|---|---|
| `sisyphus` | Master orchestrator |
| `atlas` | Plan execution orchestrator |
| `prometheus` | Planning and interview flow |
| `metis` | Gap analysis before planning |
| `momus` | Plan review and critique |
| `sisyphus-junior` | Focused implementation |
| `explore` | Codebase discovery |
| `librarian` | External docs and research |
| `oracle` | Architecture guidance |
| `hephaestus` | Build and toolchain fixes |
| `multimodal-looker` | Image and PDF analysis |
| `socrates` | Deep research interview |
| `triage` | Lightweight routing help |

## Runtime notes

- `hooks/hooks.json` currently contains 23 hook events and 38 registered command hooks. Includes: `TaskCreated`, `CwdChanged`, `FileChanged`, `WorktreeRemove` (added in v1.5.0).
- Hook handlers support `if` field with permission rule syntax (e.g., `Bash(git *)`) for argument-level filtering on tool events.
- Keyword triggers (ralph, ultrawork, handoff, create plan, run atlas, fix build, etc.) are the natural interaction model — they auto-activate skills without requiring slash commands.
- Skills support `paths:` frontmatter (glob list) for file-specific activation (e.g., `paths: "*.css, *.tsx"`).
- `CLAUDE_CODE_SUBAGENT_MODEL` env var overrides all subagent model declarations.
- Both `.omca/plans/` and Claude-native plan files are valid planning surfaces.
- `.omca/state/` is execution metadata, not the primary plan or memory store.
- Background agent barrier: when multiple background agents are running and you receive the first completion notification, END your response immediately if other agents are still pending. Never act on partial results — wait for all notifications.

## Workflow

Planning pipeline: prometheus (plan) → metis (gap analysis) → momus (review) → **user approval** → atlas (execute all tasks via /start-work).

After plan approval, the user runs `/oh-my-claudeagent:start-work` (handles plan discovery, boulder setup, worktree) or `/oh-my-claudeagent:atlas [plan path]` (direct atlas execution). Both fork atlas at depth 0. The main session agent must NEVER implement plan tasks directly — the user must explicitly invoke execution.

## Managed settings boundary

Managed settings stay outside plugin ownership. Important keys include `allowManagedHooksOnly`, `allowManagedPermissionRulesOnly`, `allowManagedMcpServersOnly`, and `sandbox.failIfUnavailable`.

Keep `teammateMode: "auto"` as the default collaboration baseline unless org policy says otherwise.
Valid `permissionMode` values: `"default"`, `"acceptEdits"`, `"plan"`, `"bypassPermissions"`, `"auto"`. Plugin agents have `permissionMode` stripped by Claude Code — do not declare it in agent frontmatter.
`permission-filter.sh` is guardrail-only and does not auto-allow commands.

## Verification reminder

Before claiming docs or runtime contract changes are done, run:

```bash
bash scripts/validate-plugin.sh
just test-hooks
```
