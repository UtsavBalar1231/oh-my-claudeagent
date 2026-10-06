# Scripts

Repository tooling, the libraries it shares, the docs capture pipeline and a manual QA
harness. No hook handler lives here: hooks are the mod under `hooks/` and the server handlers
under `servers/hooks/`. Every file is TypeScript on bun.

## Layout

- `validate.ts` and `validate/`: the plugin validator. `bun scripts/validate.ts [--check <group>]...`
  runs the groups `claims`, `formats`, `hooks`, `mod`, `tree`, `engine` and `mcp` (all of them by default),
  prints one line per check and a final `Summary:` line, and exits 1 on any failure. Each check
  family is one module under `validate/` with its `*.spec.ts` beside it. `validate/core.ts` holds
  the shared pieces: the check types, `Run` for a finished child process, `envWithout` for a
  child environment, and the tracked-file listing. The depersonalization check scans every
  shipped file, and `validate/allowlist.txt` holds its exceptions; an entry that matches nothing
  fails. `engine` packages a copy of the tree and runs `claude plugin validate --strict` on it,
  and skips without the claude CLI. `mcp` runs the omca server through the handshake fixtures, and
  `qa/install-verify.ts` reuses it on a packaged copy. The `tree` group fails a tracked python,
  bash or sh script, by its shebang or by a `.py`, `.sh` or `.bash` name. The `formats` group reads every committed state fixture (registries, ledgers, plans, notepads) through the shared parsers; `EXPECTED_INVALID` in `validate/formats.ts` lists the fixtures that must keep failing. `workflow.spec.ts`
  parses `.github/workflows/` and checks both directions: CI runs every command of every `just ci`
  recipe, and every command CI runs belongs to one of those recipes or carries a reason to run in
  CI only.
- `package.ts`: `bun scripts/package.ts <dest>` copies the shipped tree, and `--dry-run` prints
  its file list. Only files git tracks ship. `EXCLUDES` keeps out the repository tooling: every
  `*.spec.ts`, `tests/`, `scripts/` except `scripts/setup-statusline.ts` (`KEEP`), the root
  `package.json`, `bun.lock`, `bunfig.toml`, the tsconfig files, `.oxlintrc.json`, `justfile`,
  `.pre-commit-config.yaml`, `.editorconfig`, `CONTRIBUTING.md`, `opencode/`, `.opencode/` and
  `video/`. Claude Code installs npm packages whenever the plugin root holds `package.json` and a
  lockfile. A leading `/` in `EXCLUDES` anchors a pattern at the root. Packaging deletes whatever
  in `<dest>` is not on the shipped list, so it refuses a `<dest>` that is the repository or a
  directory holding it, and a non-empty `<dest>` that is not an earlier package (one whose
  `.claude-plugin/plugin.json` names `oh-my-claudeagent`). A spec checks that every relative
  import and every path a shipped file names resolves inside the shipped tree.
- `release.ts`: `bun scripts/release.ts <version>`, behind `just release <version>`. It refuses a
  version that is not semver, a tracked change in the working tree, a checkout that is not `main`
  or not even with `origin/main`, a local `plugin` branch that does not contain `origin/plugin`, a
  version with no `## [<version>]` heading in `CHANGELOG.md`, and an existing `v<version>` or
  `plugin-v<version>` tag. It writes the version into `.claude-plugin/plugin.json`, both version
  fields of `.claude-plugin/marketplace.json` and `package.json`, commits the bump and tags it
  `v<version>`. It checks that tag out into a temporary worktree, runs `packageTree`, and commits
  the result to the orphan `plugin` branch tagged `plugin-v<version>`, on top of the local branch
  or, in a fresh clone, of `origin/plugin`. A child commit of the bump rewrites the marketplace
  plugin source to a `url` source on `ref: plugin` with that commit's `sha`. It never pushes and
  prints one `git push --atomic` of both branches and both tags. A failure part way restores the
  manifests, resets to the starting HEAD with `git reset --keep`, deletes both tags and puts
  `plugin` back on its previous tip, then says so.
- `bench.ts`: `just bench`. Runs the working tree or `--candidate-ref` against `--baseline-ref`
  through the mock model. It builds each ref in a git worktree. A baseline ref that has no
  `statusline/main.ts` is installed with `uv sync`, so `uv` must be on PATH for it.
- `benchmarks/compare/` (outside this directory, packaging-excluded): the harness behind
  `just compare`, which measures OMCA against similar plugins in Docker with a mock model.
  Its README has the stages and the files.
- `setup-statusline.ts`: the status line setup behind `/oh-my-claudeagent:omca-setup`, and the one
  file under `scripts/` that ships. It copies `statusline/launcher.ts` to the config directory,
  prints a diff of the settings file and, after confirmation, sets `statusLine` and
  `subagentStatusLine`. `--uninstall` removes them.
- `postedit-check.ts`: runs `just typecheck` after an edit to a `.ts` file and reports the
  first lines of a failure as hook context. A contributor wires it as a `PostToolUse` entry in
  their own `.claude/settings.json`; `CONTRIBUTING.md` has the entry.
- `docs/`: the capture pipeline. `screenshots.ts` runs real Claude Code sessions in tmux against
  the mock model and attaches kitty to each one on a private Xvfb display. With no name it writes
  the README shots to `.github/assets/`: a PNG still per scene (ImageMagick `import`, optimized
  with `magick`) and a GIF for `pane-tour` and `guard-dialog` (`ffmpeg` x11grab, then palettegen
  and paletteuse). `clips` writes the video footage to `video/public/footage/`: per clip a BT.709
  MP4 at 30 fps, a `<clip>.json` manifest of the frames at which its states first appeared
  (`clip-manifest.ts`, which `video/src/footage.ts` mirrors) and a `<clip>.sheet.png` contact sheet
  of those frames. Each session gets a scratch HOME and config directory with the built-in `dark`
  theme, except `clip-board-light`, which uses `light`, and `fixtures/acme-app` is the project it
  opens. Pixels cannot be masked afterwards, so `privacy.ts` checks the pane's plain text before
  and after each still and throughout each recording, and refuses the capture when it shows the
  username, the home path, the hostname or the scratch directory's name. It needs Xvfb, kitty,
  tmux, xdotool, ImageMagick, ffmpeg and ffprobe, and a JetBrains Mono font that fontconfig
  (`fc-list`) finds. An interrupted run tears its sessions and scratch directory down.
  `just screenshots` runs it.
- `qa/`: the QA harness and the checks CI shares with it. `just qa` is the manual pre-release
  run. `ci-smoke.ts` is the CI smoke job and `just smoke`: one `claude -p` session with the
  packaged plugin loaded, in which the guard must deny a recursive removal (through PowerShell
  as well on Windows). `junit-complete.ts` reads the JUnit report of the CI bun spec run and
  fails unless the run has no failures and the report lists every spec file under the roots, so a
  crashed run that exits 0 still fails. `session-smoke.ts`, `hook-live-probe.ts` and
  `worktree-bash.ts` run `claude -p`, and `mcp-live.ts` runs an interactive session in tmux, each
  with the packaged plugin against the mock model (`mock-model.ts`), in a scratch project with its
  own `CLAUDE_CONFIG_DIR`. `mcp-live.ts` runs once per MCP handshake mode, against the real omca
  server with a fake ast-grep that sleeps. It checks the handshake in the client's debug log, the
  progress line on a running tool call, that Escape cancels the call and ends the fake process,
  and the title and badge of each tool in `/mcp`. `install-verify.ts` and `statusline-probe.ts`
  check the packaged tree itself. `worktree-bash.ts` and `agent-effort.ts` are steps of `just qa`.
  `visual.ts` backs `just visual <view>`, masks the scratch directory's random suffix in each
  capture, and exports the tmux helpers `mcp-live.ts` and `docs/screenshots.ts` share. `lib.ts`
  holds the shared helpers: `REPO`, checks, scratch directories, the `claude -p` launcher, the
  debug-log matchers and turn builders, signal-time cleanup and the real-config drift watch.
  `eval-tasks.ts` lists `tests/evals/tasks/*.json`.
- The two `bunfig.toml` preloads live in `tests/fixtures/`: `canonical-tmp.ts` gives every spec
  the long form of `TEMP` on Windows, and `plain-output.ts` drops `FORCE_COLOR`.
  `spec-preload.spec.ts` checks the first.

## Conventions

- Scripts use erasable syntax and `.ts` import extensions.
- A spec sits beside the script as `*.spec.ts` and runs under `just test`.
- A spec or script that spawns a process passes `env` explicitly.
- A script that runs on a contributor's machine uses `node:fs` and `Bun.spawn` argv, so it runs
  on Linux, macOS and Windows. The justfile recipes run in bash (Git Bash on Windows).
