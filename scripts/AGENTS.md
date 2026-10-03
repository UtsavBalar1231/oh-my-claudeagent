# Scripts

Repository tooling, the libraries it shares, the docs capture pipeline and a manual QA
harness. No hook handler lives here: hooks are the mod under `hooks/` and the server handlers
under `servers/hooks/`. Every file is TypeScript on bun.

## Layout

- `validate.ts` and `validate/`: the plugin validator. `bun scripts/validate.ts [--check <group>]...`
  runs the groups `claims`, `hooks`, `mod`, `tree`, `engine` and `mcp` (all of them by default),
  prints one line per check and a final `Summary:` line, and exits 1 on any failure. Each check
  family is one module under `validate/` with its `*.spec.ts` beside it, and
  `validate/allowlist.txt` holds the depersonalization exceptions. `engine` runs
  `claude plugin validate` and skips without the claude CLI. `workflow.spec.ts` ties the `just ci`
  recipe chain to the jobs in `.github/workflows/ci.yml` and to the release workflow. The `tree`
  check fails a tracked python, bash or sh script, because its allowlist is empty.
- `package.ts`: `bun scripts/package.ts <dest>` copies the shipped tree, and `--dry-run` prints
  its file list. Only files git tracks ship. The root `package.json`, `bun.lock`, `bunfig.toml`,
  `tsconfig.json`, `tsconfig.runtime.json`, `opencode/` and `.opencode/` are excluded, because
  Claude Code installs npm packages whenever the plugin root holds `package.json` and a lockfile.
  A leading `/` in `EXCLUDES` anchors a pattern at the root.
- `release.ts`: `bun scripts/release.ts <version>`, behind `just release <version>`. It refuses a
  version that is not semver, a tracked change in the working tree, a version with no
  `## [<version>]` heading in `CHANGELOG.md`, and an existing `v<version>` or `plugin-v<version>`
  tag. It writes the version into `.claude-plugin/plugin.json`, both version fields of
  `.claude-plugin/marketplace.json` and `package.json`, commits the bump and tags it
  `v<version>`. It checks that tag out into a temporary worktree, runs `packageTree`, and commits
  the result to the orphan `plugin` branch tagged `plugin-v<version>`. A child commit of the bump
  rewrites the marketplace plugin source to a `url` source on `ref: plugin` with that commit's
  `sha`. It never pushes and prints the push order, `plugin` and its tag first. A failure part
  way restores the manifests, resets to the starting HEAD with `git reset --keep`, deletes both
  tags and puts `plugin` back on its previous tip, then says so.
- `bench.ts`: `just bench`. Runs the working tree or `--candidate-ref` against `--baseline-ref`
  through the mock model. It builds each ref in a git worktree. A ref whose status line is the
  Python renderer, such as v2.21.0, is installed with `uv sync`, so `uv` must be on PATH for it.
- `setup-statusline.ts`: the status line setup behind `/oh-my-claudeagent:omca-setup`. It copies
  `statusline/launcher.ts` to the config directory, prints a diff of the settings file and,
  after confirmation, sets `statusLine` and `subagentStatusLine`. `--uninstall` removes them.
- `postedit-check.ts`: runs `just typecheck-ts` after an edit to a `.ts` file and reports the
  first lines of a failure as hook context. The local project settings call it from a
  `PostToolUse` entry.
- `docs/`: the README screens. `screenshots.ts` captures real Claude Code sessions in tmux
  against the mock model into `.github/assets/src/` as masked ANSI files, and `render-svg.ts`
  renders those to SVG in `.github/assets/` with a subset of the bundled font (`fonts/`).
  `ansi.ts`, `mask.ts` and `cmap.ts` are their helpers, and `fixtures/acme-app` is the project
  the sessions open. `just screenshots` runs both scripts in order. Packaging excludes the
  directory.
- `qa/`: the manual QA harness (`just qa`), packaging-excluded. `session-smoke.ts`,
  `hook-live-probe.ts` and `mcp-live.ts` drive Claude Code with the packaged plugin against the
  mock model (`mock-model.ts`), in a scratch project with its own `CLAUDE_CONFIG_DIR`.
  `session-smoke.ts` and `hook-live-probe.ts` run `claude -p`. `mcp-live.ts` runs an interactive
  session in tmux, once per MCP handshake mode, against the real omca server with a fake
  ast-grep that sleeps. It checks the handshake in the client's debug log, the progress line on
  a running tool call, that Escape cancels the call and ends the fake process, and the title
  and badge of each tool in `/mcp`. `install-verify.ts` and `statusline-probe.ts` check the
  packaged tree itself. `worktree-bash.ts` and `route-effort.ts` back `just qa-worktree-bash`
  and `just qa-route-effort`. `visual.ts` backs `just visual <view>` and exports the tmux
  helpers `mcp-live.ts` and `docs/screenshots.ts` share. `lib.ts` holds the shared helpers:
  checks, scratch directories, the `claude -p` launcher and the real-config drift watch.
  `eval-tasks.ts` backs `just eval-consistency` and lists `tests/evals/tasks/*.json`.

## Conventions

- Scripts use erasable syntax and `.ts` import extensions.
- A spec sits beside the script as `*.spec.ts` and runs under `just test-bun`.
- A spec or script that spawns a process passes `env` explicitly.
- A script that runs on a contributor's machine uses `node:fs` and `Bun.spawn` argv, so it runs
  on Linux, macOS and Windows.
