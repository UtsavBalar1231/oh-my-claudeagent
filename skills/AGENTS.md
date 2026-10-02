# Skill Inventory

Installed skills live in `skills/*/SKILL.md`.

## Skill list

Every skill except the orchestration entrypoints named below:

`consolidate-memory`, `debugging`, `git-master`, `github-triage`, `handoff`, `hephaestus`, `init-deep`, `metis`, `momus`, `omca-setup`, `refactor`, `remove-ai-slops`

The orchestration entrypoints are skills here too: `plan` (`skills/plan/SKILL.md`) and
`start-work` (`skills/start-work/SKILL.md`). Both set `disable-model-invocation: true` so only
a user can invoke them, and both omit `context: fork` so the body runs inline in the invoking
session, where the `Agent` tool is available and orchestration happens at depth 0.

## Public surface note

Slash commands are the primary public surface. Keyword triggers are an opt-in a user enables locally and are outside the default supported onboarding story.

## Hook Internals Boundary

Skills describe WHAT users do. Hooks are internal infrastructure that automates the HOW. Skills must NOT expose hook internals unless their primary purpose IS hook configuration or diagnosis.

**Forbidden in skills** (unless listed as an exception below):

- Raw file paths like `.omca/state/*.json`: use `boulder_write`, `boulder_progress` MCP tools from the omca server instead
- Hook handler names (`task-completed`, `stop-gates`, etc.)
- Hook event names used only in `hooks/hooks.json` (`PreToolUse`, `PostToolUse`, `Stop`, etc.): these are platform contracts, not user-facing concepts
- Hook-specific environment variables (`OMCA_DISABLED_HOOKS`, etc.)

**Exceptions (legitimate hook knowledge)**:

- `omca-setup`: installs and configures hooks

**Rationale**: Most skills already follow this rule with zero hook references (refactor, github-triage, hephaestus, metis, consolidate-memory, git-master, init-deep). Skills that leak file paths force users to understand internal layouts they can't control, and force future hook refactors to update skill prose.
