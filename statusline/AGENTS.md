# Statusline

The main status line renderer for Claude Code, in TypeScript on bun, plus the Python
renderer for the per-subagent tasks panel. Read `README.md` first for what the line shows and
how it is configured.

## Layout

- `main.ts`: entry point. Reads the payload from stdin, reads git, prints the render, and
  prints `[claude]` when anything fails.
- `render.ts`: payload types and line composition. `render(data, git, env, now)` takes the
  environment and the clock as arguments so specs control both.
- `git.ts`: branch, status counts, remote, and the 5-second cache in the temp directory.
- `config.ts`: environment-variable settings.
- `fixtures.spec.ts`, `render.spec.ts`, `git.spec.ts`, `main.spec.ts`: `bun test statusline`.
  The recorded cases live in `tests/fixtures/statusline/`.
- `subagent.py`, `core.py`, `types.py`, `tests/`: the Python subagent renderer and the helpers
  it imports. It is a separate uv project (`pyproject.toml`, `uv.lock`) that `just test-pytest`
  and `just lint-python` still cover.

## Conventions

The renderer reads `.omca/state/boulder.json` directly because it runs outside any tool call,
and resolves the plan through `src/core/boulder.ts` with `strict` set, so a session without
its own binding never shows another session's plan. It never writes the file.

Rounding of exact binary ties goes to the even neighbour (`fixed` in `render.ts`). The recorded
fixtures need it, so do not replace it with `toFixed` or `Math.round`.
