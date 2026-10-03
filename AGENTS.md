# Repository Inventory

This repository's inventory is defined by on-disk files. Query with `find`, `ls`, or `jq` against the source directory at read time rather than relying on a maintained count.

## Agent inventory

Agent definitions live in `agents/*.md`:

`executor`, `explore`, `hephaestus`, `librarian`, `metis`, `momus`, `multimodal-looker`, `oracle`, `prometheus`, `sisyphus`

## Skill inventory

Skills live in `skills/*/SKILL.md`. Every skill except the orchestration entrypoints below:

`consolidate-memory`, `debugging`, `git-master`, `github-triage`, `handoff`, `hephaestus`, `init-deep`, `metis`, `momus`, `omca-setup`, `refactor`, `remove-ai-slops`

## Orchestration entrypoints

The orchestration entrypoints are skills like any other, at `skills/plan/SKILL.md` and
`skills/start-work/SKILL.md`, invoked as `/oh-my-claudeagent:plan` and
`/oh-my-claudeagent:start-work`:

`plan`, `start-work`

Both declare `disable-model-invocation: true`, so they run only when a user types them, and
neither declares `context: fork`. Omitting `context: fork` is what keeps the body inline in
the invoking session, where the `Agent` tool is available and orchestration happens at
depth 0.

## Runtime notes

- Settings hooks live in `hooks/hooks.json` as `mcp_tool` entries that call the `omca` server's `omca_hook` tool, which dispatches through `servers/hooks/registry.ts`. The mod is `hooks/register.ts`. Shared logic is in `src/core/`, top-level scripts in `scripts/*.ts`, MCP entries in `.mcp.json`.
- `UserPromptSubmit` routes to the server's `keyword-detector` handler for activation keywords.
- The user docs are `README.md`, `docs/usage.md` and `docs/references.md`. They describe slash-first workflows, native plan and memory ownership, and managed settings as the policy boundary.
