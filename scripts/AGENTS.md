# Scripts

Repository tooling (plugin validation, packaging, the bench, the parity-title check),
supporting libraries and a manual QA harness. No hook handler lives here: hooks are the mod
under `hooks/` and the server handlers under `servers/hooks/`.

## Layout

- Top-level scripts: repository tooling, such as `validate-plugin.sh`, `package.ts`
  (`bun scripts/package.ts <dest>` copies the shipped tree, `--dry-run` prints its file list),
  `bench.ts` and `parity-titles.ts`.
- `lib/common.sh`: shared bash helpers (the stdin payload reader, state-dir resolution).
  Source it rather than reimplementing an idiom already there.
- `bin/run-hook-in-scratch.sh`: runs a hook script against a scratch copy of state
  for manual testing.
- `qa/`: the manual QA harness (`just qa`), packaging-excluded. TypeScript on bun.
  `session-smoke.ts` and `hook-live-probe.ts` drive `claude -p` with the packaged plugin
  against the mock model (`mock-model.ts`), in a scratch project with its own
  `CLAUDE_CONFIG_DIR`. `install-verify.ts` and `statusline-probe.ts` check the packaged
  tree itself. `worktree-bash.ts` and `route-effort.ts`
  back `just qa-worktree-bash` and `just qa-route-effort`. `qa/lib.ts` holds the shared
  helpers: checks, scratch directories, the `claude -p` launcher and the real-config drift watch.

## Conventions

Hook-authoring conventions for a script here:

- Never `set -euo pipefail`. A hook degrades gracefully when state files are missing.
- Read the payload from stdin (`INPUT=$(cat)`) and parse fields with `jq`.
- Write state atomically: `tmp=$(mktemp) && ... && mv "$tmp" target.json`.
- Default to `exit 0`. Succeed silently when the script's condition does not apply.
- Block from a `PreToolUse` hook with a stderr message and `exit 2`. The platform reads JSON
  output fields from stdout on every exit code, not just 0, and exit 2's block is the one
  outcome that JSON cannot override. The blocking message is the reason from a blocking
  decision in the JSON when there is one, and the stderr text otherwise, which is why the
  exit-2 paths here stay stderr-only: it keeps the reason unambiguous.
- `exit 2` does not deny a `PermissionRequest` hook. The per-event table in
  `claude-code-docs/docs/hooks.md` states that exit code 2 is not honored for that event,
  the permission flow proceeds unchanged, and the stderr is discarded; only the `decision`
  object can grant or deny. A script registered on both events must therefore branch on
  `hook_event_name` and emit the shape that event reads:
  `hookSpecificOutput.permissionDecision` for `PreToolUse`,
  `hookSpecificOutput.decision.behavior` for `PermissionRequest`. The branch is required,
  not a hedge against an open question.
- A deny gate never allows a command it failed to recognise. Silence, `exit 0` with no
  stdout, is the answer to a command the pattern does not match; a trailing allow
  auto-approves everything the gate missed. A command the gate positively recognised and
  translated may be allowed through an `updatedInput` rewrite instead. That is a
  restatement of a matched command, not a fallback for an unmatched one.
- Keep state under `.omca/state/` relative to `CLAUDE_PROJECT_ROOT`, never `~/.claude/`.
- Reference the plugin root as `$(dirname "$0")/..`.
- Source `lib/common.sh` and use its helpers rather than reimplementing an idiom.
- Give every numeric constant a single-line derivation comment within two lines above it.
  Write `UNDOCUMENTED` when the rationale is not discoverable rather than guessing.
- Do not cite plan task numbers or plan filenames in a comment. Write the invariant.
- Register the script in `hooks/hooks.json`. An unregistered script is dead code.
- Tabs for indentation, per `.editorconfig`. shellcheck runs with `enable=all`.
