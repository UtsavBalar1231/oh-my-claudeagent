# Contributing to oh-my-claudeagent

## Prerequisites

- `jq`, used by the validator and the shell scripts
- `bun` 1.4.2 or later, runtime for the MCP server, the hooks module, the status line and the scripts
- `ast-grep` CLI (`ast-grep` or `sg`), structural code-search tools
- `just`, task runner for dev commands

Run `just setup` to install the pre-commit git hooks.

Structural changes to a directory (new file, moved entry point, changed layout) update that directory's `AGENTS.md` in the same change.

## Adding a hook

Two steps are required. Skipping either produces dead code ([ADR-009](adr/README.md#adr-009)):

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

Use the `if` field for argument-level filtering on tool events (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`): `"if": "Bash(git *)"`, permission rule syntax, reduces process spawning. Do not use on security-critical or dual-purpose hooks where a narrow filter would silently disable coverage.

Each hook runs as a fresh process, so an edit to the body of `scripts/name.sh` applies on the next invocation. A change to `hooks/hooks.json` is registration, not script content, and applies only once the plugin is loaded again: closing the `/plugin` menu reloads it for you, and so does starting a new session.

## Adding an agent

Create `agents/name.md` with YAML frontmatter:

```yaml
---
name: agent-name
description: One-line role description
model: sonnet|opus|fable
effort: max|xhigh|high|medium|low
disallowedTools: Write, Edit  # use disallowedTools, NOT tools:
memory: project                   # optional; enables persistent project memory
---
```

Key rules:
- Declare the tier alias in `model:`, not a full generation ID. The alias tracks the platform's current model for that tier, so the frontmatter never goes stale. The roster uses three tiers: `sonnet` for routine workers whose scope the orchestrator fixes (search, scoped implementation, docs lookup), `opus` for agents whose output turns on judgment, and `fable` for oracle-class reasoning. `haiku` remains a valid per-call override but is not what a new agent declares.
- Pick `effort:` deliberately, alongside the tier. `low` suits short scoped work that is not intelligence-sensitive, `medium` is the Sonnet 5.5 and Opus 5.5 default for day-to-day work with a clear scope, `high` is the intelligence-sensitive default for orchestration and planning, `xhigh` buys deeper reasoning for oracle. Reserve `xhigh` and `max` for a measured quality gain: Opus 5.5 thinks more per turn at a given level than Opus 5 did.
- Use `disallowedTools:` to restrict capabilities, never `tools:`. `tools:` is a strict allowlist that blocks MCP tool inheritance, and an incomplete list launches the agent with no usable tools. `bun scripts/validate.ts --check claims` fails on a `tools:` key in agent frontmatter.
- Keep `name:` free of `:`. The platform rejects an agent whose frontmatter name holds a colon, so the agent never loads. The `oh-my-claudeagent:` prefix used at call sites is added by the platform.
- Do not declare `permissionMode:`. Claude Code strips it from plugin agents for security.
- Add the agent to the agent catalog table in `templates/claudemd.md`
- **`CLAUDE_CODE_SUBAGENT_MODEL` no longer outranks frontmatter.** Since v2.1.251 the order is a per-invocation model first, then the agent definition's `model:` field (`inherit` included), then the environment variable. Every agent on this roster declares `model:`, so the variable is a default that never applies here. The variable that does override a definition is `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` (v2.1.257 or later): with it set, the declared tier is ignored for every agent, oracle's `fable` included.
- **Do not leak hook internals into agent prompts.** State the behavioral rule, not the enforcement mechanism. Agent prompts must NOT mention: hook script names (`final-verification-evidence.sh`, `task-completed-verify.sh`, etc.), "X hook" as a noun (`SubagentStart hook`, `Stop hook`, `the final-verification hook`), raw `.omca/state/*.json` file paths, or cross-references to specific plan names/task numbers for enforcement rationale. Describe the behavior instead: *"session termination is blocked until final-verification evidence is present"* not *"the `final-verification-evidence.sh` hook blocks Stop"*. Exception: platform event names like `TaskCreated`, `TaskCompleted`, `TeammateIdle` may appear as API contract references, but do not frame them as "lifecycle hooks"; use "lifecycle events" or "platform lifecycle gates". Naming internal scripts in agent prose creates stale prompts whenever hooks are renamed, refactored, or replaced with MCP tools.

## Adding a skill

1. Create `skills/name/SKILL.md`. A directory without `SKILL.md` is ignored by Claude Code.
2. Follow existing frontmatter format (`name`, `description`, `argument-hint` if applicable)
3. If the skill should be keyword-activated, add a detection pattern to `src/core/keywords.ts`
4. A skill that omits `context: fork` expands inline in whatever session invoked it, so one invoked from the main session runs at depth 0 and keeps that session's `Agent` tool. That is what an orchestrator skill needs; `start-work` is the worked example, fanning out to `executor` agents from an inline body. `context: fork` does the opposite. It runs the body in a forked subagent one level down, where the platform may withhold the `Agent` tool depending on the configured spawn depth, so do not reach for it when the body has to delegate.
5. **Skill descriptions have a 512-character soft cap and a 1,536-character hard cap** (the platform truncates at the hard cap; older clients may truncate at the soft cap). Run `just test-claims` before committing; it counts `description` plus `when_to_use`, warns at 512 and fails at 1,536. Move longer trigger phrases or usage notes into the SKILL.md body.
6. **Do not leak hook internals.** Skills describe WHAT users do; hooks automate HOW. Unless the skill's primary purpose IS hook configuration or diagnosis, skills must NOT mention: raw `.omca/state/*.json` file paths (use the `boulder_write`, `boulder_progress` MCP tools from the omca server instead), hook script names (`task-completed-verify.sh`, etc.), hook event names (`PreToolUse`, `Stop`, etc.), or hook env vars (`HOOK_INPUT`, `HOOK_STATE_DIR`). Recognized exceptions: `omca-setup` (installs hooks), `stop-continuation` (clears hook-managed state). Exposing file paths forces users to understand internal layouts they cannot control, and forces every future hook refactor to update skill prose.

## Testing

```bash
just ci              # full pipeline: lint + test + mcp + manifest + opencode + TypeScript checks
just test            # structural validation only (claims, hooks, mod, tree, engine), not the full suite
just test-claims     # manifest, frontmatter, docs and policy checks
just test-hooks      # hooks.json handler shape, SessionStart matcher and registry checks
just test-mcp        # MCP server specs (requires ast-grep CLI) and the handshake check
just test-bun        # every bun spec, including the validator specs
just qa              # manual QA against the mock model: session smoke, install verify, live hook probe, statusline probe, worktree and route-effort checks
just lint            # shellcheck
just typecheck-ts    # both tsc projects
```

Use `just ci` before claiming a change is verified; `just test` alone is a structural subset.

## Post-fix verification for race and timing bugs

Hook race and timing fixes are easy to claim fixed without ever re-triggering the
original failure. Follow this checklist:

1. When filing the bug, capture a reproducer (exact command sequence, timing, or fixture)
   that reliably triggers the race, not just a description of the symptom.
2. Before closing the fix, re-run that exact reproducer against the fix commit.
3. Record the verdict in the commit message or changelog entry: reproducer ran and no
   longer fails, or reproducer still flakes under N runs.
4. If the reproducer cannot be re-obtained (for example it depended on since-changed CI
   timing), record the fix as "fix unverified end-to-end" rather than "fixed".

## Plugin configuration

**Custom paths replace defaults**: the `commands`, `agents`, `skills`, and `outputStyles` fields in `plugin.json` replace the platform's default directories rather than adding to them. To keep the default directory alongside a custom one, include the default path explicitly in the array.

## Release process

`just release [version]` is the whole process. It requires a clean working tree, then bumps
the version in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and
`package.json` together, commits, stamps the resulting HEAD SHA into
`marketplace.json` for deterministic installs, and tags. Add the CHANGELOG entry for the
version first; the recipe validates that it exists.

Prefer the recipe over hand-editing the three version fields, which must stay identical.
