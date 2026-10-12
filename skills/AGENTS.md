# Skill inventory

Installed skills are `skills/*/SKILL.md`.

## Skill list

Every skill except the orchestration entrypoints named below:

`analyzer`, `build-fixer`, `consolidate-memory`, `debugging`, `git-master`, `github-triage`, `handoff`, `init-deep`, `omca-setup`, `refactor`, `remove-ai-slops`, `reviewer`

The orchestration entrypoints are skills here too: `plan` (`skills/plan/SKILL.md`) and
`start-work` (`skills/start-work/SKILL.md`). Both set `disable-model-invocation: true` so only
a user can invoke them, and both omit `context: fork` so the body runs inline in the invoking
session, where the `Agent` tool is available and orchestration happens at depth 0.

## Public surface

Slash commands are the primary public surface. Keyword triggers are opt-in, a user enables them locally, and the default onboarding does not cover them.

## Hook internals boundary

Skills describe what users do. Hooks are internal infrastructure that automates how. A skill does not expose hook internals unless its primary purpose is hook configuration or diagnosis.

Forbidden in skills, unless listed as an exception below:

- Raw file paths like `.omca/state/*.json`: use the `boulder_write` and `boulder_progress` MCP tools from the omca server instead
- Hook handler names (`task-completed`, `stop-gates`, etc.)
- Hook event names used only in `hooks/hooks.json` (`PreToolUse`, `PostToolUse`, `Stop`, etc.): these are platform contracts that users never need
- Hook-specific environment variables (`OMCA_DISABLED_HOOKS`, etc.)

Exceptions, where hook knowledge is the skill's purpose:

- `omca-setup`: states the hook and managed-settings policy it works under, and sends a diagnosis to `/omca doctor`

Rationale: a skill that leaks a file path forces users to learn internal layouts they cannot control, and every hook refactor then has to update skill prose.
