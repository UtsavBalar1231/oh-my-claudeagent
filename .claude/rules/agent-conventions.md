---
globs: agents/*.md
description: Agent frontmatter conventions for oh-my-claudeagent plugin agents
---

When editing or creating agent definitions:

- **Use `disallowedTools:`** never `tools:` — `tools:` creates a strict allowlist that blocks MCP tool inheritance. Only exception: multimodal-looker (`tools: Read`, intentionally very restricted).
- **Model field**: pin an exact generation with a full ID — `claude-fable-5`, `claude-opus-4-8`, or `claude-sonnet-5` — which is what every OMCA agent does so the statusline shows the real generation. Aliases (`opus`, `sonnet`, `fable`, `best`, `opusplan`) also work but don't pin a version. `opusplan` uses Opus in plan mode and Sonnet for execution; `best` resolves to the most capable available model. Haiku is off the default roster (outdated) but remains a supported override model — `Agent(..., model="haiku")` still works; just don't assign it as an agent's default `model:`.
- **Required frontmatter**: name, description, model. Add `disallowedTools:` when restricting capabilities.
- **No `permissionMode:`** — this field is stripped from plugin agents by Claude Code for security. Do not declare it. Plugin agents inherit the parent session's permission context.
- **`memory: project`** enables Claude-native project memory. Not a plugin surface.
- **`## Memory Guidance` body section**: agents with `memory: project` declare role-specific save triggers in a `## Memory Guidance` body section. Include at least 2 role-specific negative examples. Do NOT restate the platform-injected protocol (typed categories, `MEMORY.md` format, write mechanics) — the platform auto-injects those when `memory:` is set.
- **Optional display/behavior fields**: `color` (red, blue, green, yellow, purple, orange, pink, cyan) for task list differentiation, `background: true` to always run as background task, `isolation: worktree` to run in isolated git worktree.
- **Scaffold**: `just new-agent NAME` creates boilerplate. Update description, model, and disallowedTools after.
- **No `initialPrompt:` in plugin agents** — this field only fires for main session agents (via `claude --agent`). Plugin agents are invoked as subagents where `initialPrompt` has no effect.
- After adding an agent, update: `templates/claudemd.md` (agent catalog table), README.md (agent count).

When editing or creating skill definitions (`skills/*/SKILL.md`):

- **Skill description cap**: 1,536 characters hard limit (v2.1.105+). Internal soft cap is ≤512 characters — keep descriptions concise to avoid truncation in reduced-context windows. Run `validate-plugin.sh` (warns at 512, fails at 1,536).

### Agent color map (v2.2.0+)

<!-- v2.1.140 palette re-verified 2026-05-13 against https://code.claude.com/docs/en/sub-agents: matches current 8-color set (red/blue/green/yellow/purple/orange/pink/cyan). See .omca/notes/agent-color-palette-v140.md for the captured quote. -->

Platform supports 8 colors: `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan`.
OMCA has 10 agents, so two colors are shared between agents that rarely run concurrently.

| Agent | Color | Role / Rationale |
|---|---|---|
| sisyphus | purple | Orchestrator — royal/deep-think |
| prometheus | cyan | Planner — cool/communicative |
| metis | yellow | Pre-plan gap analysis — analytical |
| momus | red | Plan critic — alert/error |
| executor | green | Implementation — build/ship |
| explore | blue | Local search — ocean/depth |
| librarian | orange | External research — warm/discovery |
| oracle | purple | Deep advisor — shares with sisyphus (oracle never orchestrates; sisyphus never advises in same turn) |
| hephaestus | yellow | Build fixer — shares with metis (hephaestus is fix-time; metis is plan-time) |
| multimodal-looker | pink | Visual analyst — unique |

Update this table if a sharing pair causes actual UX confusion in task lists.

### `subagent_type` matching (v2.1.140+)

The Agent tool matches `subagent_type` case- and separator-insensitively. `"Code Reviewer"`, `"code-reviewer"`, `"code_reviewer"`, and `"CodeReviewer"` all resolve to the canonical `code-reviewer` agent.

**OMCA delegation continues to use the canonical lowercase-kebab form** (`oh-my-claudeagent:executor`, not `Oh My ClaudeAgent: Executor`). The case-insensitive matching is forgiveness for end-user typos, not a license to invent variants. All OMCA agent docs, skill prompts, and orchestration examples use the canonical form; new content must too.
