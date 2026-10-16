# Working in this repository

## Commands and verification

- Use Bun, not npm scripts: `bun install --frozen-lockfile`. CI pins Bun 1.4.2.
  `just setup` only installs pre-commit hooks; it does not install dependencies.
- Run `just ci` before claiming full verification. Its order is
  `lint -> typecheck -> validate -> test -> test-mod -> test-opencode -> smoke`.
  Recipes use bash, including Git Bash on Windows.
- `just typecheck` checks separate mod, Bun runtime and OpenCode projects.
- `just validate` checks docs and runtime contracts. Focus with
  `just validate --check <group>`: `claims`, `formats`, `hooks`, `mod`, `tree`, `engine`, `mcp`.
  The engine group skips without `claude`; a passing validator can therefore be incomplete.
- Bun specs are colocated `*.spec.ts`. Run one with
  `bun test --timeout=30000 ./servers/tools/ast.spec.ts`, optionally `-t '<test name>'`.
  `just test` selects explicit roots; bare `bun test` also collects mod tests that need
  `just test-mod` (`claude plugin test .`). OpenCode specs run separately with `just test-opencode`.
- Full checks need `ast-grep` (or `sg`) and Claude Code (CI pins 2.1.301).
  OpenCode integration specs skip without `opencode` on PATH; CI installs 2.0.29.
  `just smoke` uses a mock model; `tests/plugin-evals/` calls a real model and is manual.

## Runtime boundaries

- `src/core/` is shared with the Claude mod: keep it free of `node:`/`bun:` imports
  and Bun globals. Mod code uses the engine through `Host` in `hooks/host.ts`.
  `servers/`, `statusline/` and `scripts/` run on Bun, outside the mod engine.
- `.mcp.json` launches `servers/omca.ts`. Settings hooks in `hooks/hooks.json` call
  its `omca_hook` tool; `servers/hooks/registry.ts` must reach each handler.
  Mod features register through `hooks/register.ts`, the only file that calls `on()`.
- Hooks may deny, ask or steer, never allow. Keep `PermissionRequest` unregistered;
  allow decisions belong to native permission settings. See `hooks/AGENTS.md`.
- `opencode/index.ts` is the server plugin; `opencode/rpc.ts` is the import-safe
  contract for the optional TUI. Read `opencode/AGENTS.md` before adapter work.
  OpenCode has no Stop veto; historical evidence is not current-checkout verification.
- After OpenCode UI or RPC changes, run `just build-opencode` and include
  `opencode/tui.generated.js` with the source changes. Never edit it by hand.
  `just test-opencode` checks artifact freshness before running specs.
- `.claude-plugin/types/` is an engine-generated snapshot. Refresh with `just types`
  using the Claude CLI version pinned in CI; validation rejects a different generator
  version. Do not edit manually; pre-commit leaves these files byte-identical.

## Prompts and instructions

- Query on-disk inventories rather than asserting counts. Agents are `agents/*.md`:
  `analyzer`, `architect`, `build-fixer`, `executor`, `explorer`, `orchestrator`,
  `planner`, `researcher`, `reviewer`, `viewer`. When adding one, also update
  `templates/claudemd.md`, `docs/references.md` and this list.
- Skills are `skills/*/SKILL.md`. Keep `plan` and `start-work` user-only
  (`disable-model-invocation: true`) and inline (no `context: fork`) so orchestration
  retains the invoking session's `Agent` tool. See `skills/AGENTS.md` for prompt boundaries.
- Restrict agent tools with `disallowedTools`, not `tools`: an allowlist blocks MCP
  inheritance. Use model tier aliases in frontmatter, not generation IDs.
- Read `CONTRIBUTING.md` for prose and prompt contracts. Keep model-facing text about
  current behavior; preserve machine-consumed headings, tokens and frontmatter.
  Update a directory's `AGENTS.md` when changing its structure.

## Packaging

- Claude marketplace installs use the packaged `plugin` branch, not the development
  tree. `scripts/package.ts` ships only git-tracked files and excludes dependencies,
  root manifests, tests, `opencode/` and most scripts. Keep shipped imports inside
  that tree; `scripts/setup-statusline.ts` is the script exception.
- For an authorized release, use `just release <version>` rather than manual version
  edits. It commits and tags both trees but never pushes; add the matching CHANGELOG
  heading first. Prerequisites and push order are in `CONTRIBUTING.md`.
