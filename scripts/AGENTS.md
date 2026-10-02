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
  `claude plugin validate` and skips without the claude CLI. No python, bash or sh script is
  allowed: the allowlist in `validate/tree.ts` is empty, so a tracked file with such a shebang
  fails the `tree` check.
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
  `eval-tasks.ts` backs `just eval-consistency` and lists `tests/evals/tasks/*.json`.

## Conventions

- Every script is TypeScript on bun, with erasable syntax and `.ts` import extensions.
- A spec sits beside the script as `*.spec.ts` and runs under `just test-bun`.
- A spec or script that spawns a process passes `env` explicitly.
