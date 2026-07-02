# Skill Inventory

Installed skills live in `skills/*/SKILL.md`.

## Skill list

`consolidate-memory`, `debugging`, `dev-browser`, `frontend-ui-ux`, `git-master`, `github-triage`, `handoff`, `hephaestus`, `init-deep`, `metis`, `momus`, `omca-setup`, `playwright`, `refactor`, `remove-ai-slops`

Orchestration entrypoints moved to `commands/*.md`: `plan`, `start-work`. Skills removed in v2.10: `cancel-ralph`, `stop-continuation`, `ralph`, `ultrawork`, `ulw-loop`. Also deleted: `sisyphus-orchestrate`, `atlas`, `prometheus-plan`.

## Public surface note

The hard cutover docs treat slash commands as the primary public surface. Keyword-trigger compatibility, if a user keeps it locally, is outside the default supported onboarding story.

## Hook Internals Boundary

Skills describe WHAT users do. Hooks are internal infrastructure that automates the HOW. Skills must NOT expose hook internals unless their primary purpose IS hook configuration or diagnosis.

**Forbidden in skills** (unless listed as an exception below):

- Raw file paths like `.omca/state/*.json` — use `boulder_write`, `boulder_progress` MCP tools from the omca server instead
- Hook script names (`task-completed-verify.sh`, etc.)
- Hook event names used only in `hooks/hooks.json` (`PreToolUse`, `PostToolUse`, `Stop`, etc.) — these are platform contracts, not user-facing concepts
- Hook-specific environment variables (`HOOK_INPUT`, `HOOK_STATE_DIR`)

**Exceptions (legitimate hook knowledge)**:

- `omca-setup` — installs and configures hooks

**Rationale**: Most skills already follow this rule with zero hook references (refactor, github-triage, hephaestus, metis, consolidate-memory, dev-browser, frontend-ui-ux, git-master, init-deep, playwright). Skills that leak file paths force users to understand internal layouts they can't control, and force future hook refactors to update skill prose.
