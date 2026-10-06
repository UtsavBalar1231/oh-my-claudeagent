# Repository inventory

On-disk files define the inventory. Query it with `find`, `ls` or `jq` at read time, and keep no count of it.

## Agent inventory

Agent definitions are `agents/*.md`:

`analyzer`, `architect`, `build-fixer`, `executor`, `explorer`, `orchestrator`, `planner`, `researcher`, `reviewer`, `viewer`

## Skill inventory

Skills are `skills/*/SKILL.md`. Every skill except the orchestration entrypoints below:

`analyzer`, `build-fixer`, `consolidate-memory`, `debugging`, `git-master`, `github-triage`, `handoff`, `init-deep`, `omca-setup`, `refactor`, `remove-ai-slops`, `reviewer`

## Orchestration entrypoints

The orchestration entrypoints are skills at `skills/plan/SKILL.md` and
`skills/start-work/SKILL.md`, invoked as `/oh-my-claudeagent:plan` and
`/oh-my-claudeagent:start-work`:

`plan`, `start-work`

Both declare `disable-model-invocation: true`, so they run only when a user types them.
Neither declares `context: fork`, which keeps the body inline in the invoking session, where
the `Agent` tool is available and orchestration happens at depth 0.

## Runtime notes

- Settings hooks live in `hooks/hooks.json` as `mcp_tool` entries that call the `omca` server's `omca_hook` tool, which dispatches through `servers/hooks/registry.ts`. The mod is `hooks/register.ts`. Shared logic is in `src/core/`, top-level scripts in `scripts/*.ts`, MCP entries in `.mcp.json`.
- `UserPromptSubmit` routes to the server's `keyword-detector` handler for activation keywords.
- The user docs are `README.md`, `docs/usage.md` and `docs/references.md`. They describe slash-first workflows, native plan and memory ownership, and managed settings as the policy boundary.
