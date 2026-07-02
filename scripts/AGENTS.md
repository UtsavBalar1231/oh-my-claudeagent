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

Hook-authoring conventions (stdin/jq parsing, atomic writes, exit codes, logging
channels, magic-number comments) live in `.claude/rules/hook-scripts.md`. Read that
before adding or editing a script here, not this file.
