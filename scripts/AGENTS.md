# Scripts

Repository tooling (plugin validation, packaging, the bench),
supporting libraries and a manual QA harness. No hook handler lives here: hooks are the mod
under `hooks/` and the server handlers under `servers/hooks/`.

## Layout

- Top-level scripts: repository tooling, such as `validate.ts`, `package.ts`
  (`bun scripts/package.ts <dest>` copies the shipped tree, `--dry-run` prints its file list)
  and `bench.ts`.
- `validate.ts` and `validate/`: the plugin validator. `bun scripts/validate.ts [--check <group>]...`
  runs the groups `claims`, `hooks`, `mod`, `tree`, `engine` and `mcp` (all of them by default),
  prints one line per check and a final `Summary:` line, and exits 1 on any failure. Each check
  family is one module under `validate/` with its `*.spec.ts` beside it, and
  `validate/allowlist.txt` holds the depersonalization exceptions. `engine` runs
  `claude plugin validate` and skips without the claude CLI. A script that needs a python, bash
  or sh shebang is allowlisted with its reason in `validate/tree.ts`.
- `postedit-check.ts`: runs `just typecheck-ts` after an edit to a `.ts` file and reports the
  first lines of a failure as hook context. The local project settings call it from a
  `PostToolUse` entry.
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
- Give every numeric constant a single-line derivation comment within two lines above it.
  Write `UNDOCUMENTED` when the rationale is not discoverable rather than guessing.
- Do not cite plan task numbers or plan filenames in a comment. Write the invariant.
- Register the script in `hooks/hooks.json`. An unregistered script is dead code.
- Tabs for indentation, per `.editorconfig`. shellcheck runs with `enable=all`.
