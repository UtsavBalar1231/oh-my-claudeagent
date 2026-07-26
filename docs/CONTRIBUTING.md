# Contributing to oh-my-claudeagent

## Prerequisites

- `jq` — used by all hook scripts
- `uv` — Python dependency management for MCP servers
- `python3` 3.10+ — MCP server runtime
- `ast-grep` CLI (`ast-grep` or `sg`) — structural code-search tools
- `just` — task runner for dev commands

Run `just setup` to install dev dependencies (ruff, pre-commit) and git hooks.

Structural changes to a directory (new file, moved entry point, changed layout) update that directory's `AGENTS.md` in the same change.

## Adding a Hook

Two steps are required — skipping either step produces dead code ([ADR-009](adr/README.md#adr-009)):

1. **Create the script** at `scripts/name.sh`. Follow conventions:
   - Read payload from stdin via `jq`
   - Write state atomically (`tmp=$(mktemp) && ... && mv "$tmp" target.json`)
   - Exit 0 by default; degrade gracefully when state files are absent
   - Do NOT use `set -euo pipefail`

2. **Register in `hooks/hooks.json`**:
   ```json
   {
     "matcher": "EventName",
     "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/name.sh" }]
   }
   ```

Use the `if` field for argument-level filtering on tool events (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`): `"if": "Bash(git *)"` — permission rule syntax, reduces process spawning. Do not use on security-critical or dual-purpose hooks where a narrow filter would silently disable coverage.

Plugin hook changes require `/reload-plugins` to take effect (not auto-reloaded).

## Adding an Agent

Create `agents/name.md` with YAML frontmatter:

```yaml
---
name: agent-name
description: One-line role description
model: opus|fable
effort: max|xhigh|high|medium|low
disallowedTools: Write, Edit  # use disallowedTools, NOT tools:
memory: project                   # optional; enables persistent project memory
---
```

Key rules:
- Declare the tier alias in `model:`, not a full generation ID. The alias tracks the platform's current model for that tier, so the frontmatter never goes stale. The roster uses two tiers: `opus` for every agent the plugin spawns, `fable` for oracle-class reasoning. Other aliases such as `sonnet` and `haiku` remain valid per-call overrides but are not what a new agent declares.
- Pick `effort:` deliberately, because it is what separates one agent from another now that the model column does not. `low` suits short scoped work that is not intelligence-sensitive, `medium` trades some intelligence for lower token spend, `xhigh` buys deeper reasoning for orchestration and planning, `max` is for the advisor role.
- Use `disallowedTools:` to restrict capabilities — never `tools:` (blocks MCP inheritance, [Known Limitations](../CLAUDE.md#agent-tools-allowlist-blocks-mcp-tool-inheritance))
- Do not declare `permissionMode:` — it is stripped from plugin agents by Claude Code for security
- Add the agent to the `<agent_catalog>` block in `templates/claudemd.md`
- **`CLAUDE_CODE_SUBAGENT_MODEL` env var overrides ALL agent model declarations** — warn users if they set this, as it affects every spawned agent regardless of frontmatter.
- **Do not leak hook internals into agent prompts.** State the behavioral rule, not the enforcement mechanism. Agent prompts must NOT mention: hook script names (`plan-checkbox-verify.sh`, `final-verification-evidence.sh`, `task-completed-verify.sh`, etc.), "X hook" as a noun (`SubagentStart hook`, `Stop hook`, `the final-verification hook`), raw `.omca/state/*.json` file paths, or cross-references to specific plan names/task numbers for enforcement rationale. Describe the behavior instead: *"session termination is blocked until final-verification evidence is present"* not *"the `final-verification-evidence.sh` hook blocks Stop"*. Exception: platform event names like `TaskCreated`, `TaskCompleted`, `TeammateIdle` may appear as API contract references, but do not frame them as "lifecycle hooks" — use "lifecycle events" or "platform lifecycle gates". Rationale: naming internal scripts in agent prose creates stale prompts whenever hooks are renamed, refactored, or replaced with MCP tools.

## Adding a Skill

1. Create `skills/name/SKILL.md` — a directory without `SKILL.md` is ignored by Claude Code
2. Follow existing frontmatter format (`name`, `description`, `argument-hint` if applicable)
3. If the skill should be keyword-activated, add a detection pattern to `scripts/keyword-detector.sh`
4. Skills with `context: fork` run at depth 0 — use for orchestrators that need the `Agent` tool
5. **Skill descriptions have a 512-character soft cap and a 1,536-character hard cap** (the platform truncates at the hard cap; older clients may truncate at the soft cap). Run `validate-plugin.sh` before committing; it warns at 512 and fails at 1,536. Move longer trigger phrases or usage notes into the SKILL.md body.
6. **Do not leak hook internals.** Skills describe WHAT users do; hooks automate HOW. Unless the skill's primary purpose IS hook configuration or diagnosis, skills must NOT mention: raw `.omca/state/*.json` file paths (use the `boulder_write`, `boulder_progress` MCP tools from the omca server instead), hook script names (`task-completed-verify.sh`, etc.), hook event names (`PreToolUse`, `Stop`, etc.), or hook env vars (`HOOK_INPUT`, `HOOK_STATE_DIR`). Recognized exceptions: `omca-setup` (installs hooks), `stop-continuation` (clears hook-managed state). Rationale: exposing file paths forces users to understand internal layouts they can't control and forces every future hook refactor to update skill prose.

## Testing

```bash
just ci              # full pipeline: fmt-check + lint + test
just test-claims     # structural validation (agent/skill/hook counts vs CLAUDE.md)
just test-hooks      # hook scripts with fixture payloads
just test-mcp        # MCP server tool listing (requires ast-grep CLI)
just lint            # shellcheck + ruff
just fmt-check       # format check without changes
```

Add fixture payloads to `tests/fixtures/hooks/` for new hook scripts. The claims check
validates counts declared in CLAUDE.md against on-disk reality — update counts when adding
agents or skills.

## Post-fix Verification for Race and Timing Bugs

Hook race and timing fixes are easy to claim fixed without ever re-triggering the
original failure. Follow this checklist:

1. When filing the bug, capture a reproducer (exact command sequence, timing, or fixture)
   that reliably triggers the race, not just a description of the symptom.
2. Before closing the fix, re-run that exact reproducer against the fix commit.
3. Record the verdict in the commit message or changelog entry: reproducer ran and no
   longer fails, or reproducer still flakes under N runs.
4. If the reproducer cannot be re-obtained (e.g. it depended on since-changed CI timing),
   say so honestly: record the fix as "fix unverified end-to-end" rather than "fixed".

## Plugin Configuration

**Custom paths replace defaults**: `commands`, `agents`, `skills`, and `outputStyles` fields in `plugin.json` replace the platform's default directories — they are not additive. To keep the default directory alongside a custom one, include the default path explicitly in the array.

## Release Process

1. Bump `version` in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (keep identical)
2. Run `just release` to stamp the HEAD SHA into `marketplace.json`
3. Tag the commit: `git tag v<version>`

The `just release` recipe updates `marketplace.json` for deterministic installs — run it as
the last step before tagging.
