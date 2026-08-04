# Scripts

Shell hook handlers registered in `hooks/hooks.json`, plus supporting libraries and
a manual QA harness.

## Layout

- Top-level `*.sh`: one script per hook handler (e.g. `session-init.sh`,
  `task-completed-verify.sh`, `subagent-start.sh`). Each is wired to an event in
  `hooks/hooks.json`; an unregistered script is dead code.
- `lib/common.sh`: shared bash helpers (logging, state-dir resolution, session-id
  lookup). Source it rather than reimplementing an idiom already there.
- `bin/run-hook-in-scratch.sh`: runs a hook script against a scratch copy of state
  for manual testing.
- `qa/`: the manual QA harness (`just qa`), packaging-excluded. Installs, live-probes
  hooks, and exercises the statusline against a real plugin install. `qa/lib/qa-common.sh`
  holds its isolation helpers.

## Conventions

Hook-authoring conventions for a script here:

- Never `set -euo pipefail`. A hook degrades gracefully when state files are missing.
- Read the payload from stdin (`INPUT=$(cat)`) and parse fields with `jq`.
- Write state atomically: `tmp=$(mktemp) && ... && mv "$tmp" target.json`.
- Default to `exit 0`. Succeed silently when the script's condition does not apply.
- Block from a `PreToolUse` hook with a stderr message and `exit 2`; the platform ignores
  stdout JSON on a non-zero exit and sends the stderr text to the model. `exit 2` does
  **not** block a `PermissionRequest` hook — that event reads its answer only from
  `hookSpecificOutput.decision.behavior` on stdout with `exit 0`, and ignores the exit
  status entirely. A script registered on both events must emit both shapes:
  `hookSpecificOutput.permissionDecision` for `PreToolUse`,
  `hookSpecificOutput.decision.behavior` for `PermissionRequest`. See the two-shape
  branch in `permission-filter.sh` for the reference implementation. Block from a `Stop`
  hook with `{"decision": "block", "reason": "..."}` on stdout and `exit 0`.
- Keep state under `.omca/state/` relative to `CLAUDE_PROJECT_ROOT`, never `~/.claude/`.
- Reference the plugin root as `$(dirname "$0")/..`.
- Source `lib/common.sh` and use its helpers rather than reimplementing an idiom.
- Give every numeric constant a single-line derivation comment within two lines above it.
  Write `UNDOCUMENTED` when the rationale is not discoverable rather than guessing.
- Do not cite plan task numbers or plan filenames in a comment. Write the invariant.
- Register the script in `hooks/hooks.json`. An unregistered script is dead code.
- Tabs for indentation, per `.editorconfig`. shellcheck runs with `enable=all`.
