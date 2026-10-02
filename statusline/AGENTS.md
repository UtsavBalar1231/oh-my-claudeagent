# Statusline

The main status line and the per-subagent tasks panel renderers for Claude Code, in TypeScript
on bun. Read `README.md` first for what they show and how they are configured.

## Layout

- `main.ts`: entry point. Reads the payload from stdin, reads git, prints the render, and
  prints `[claude]` when anything fails.
- `render.ts`: payload types and line composition. `render(data, git, env, now)` takes the
  environment and the clock as arguments so specs control both.
- `git.ts`: branch, status counts, remote, and the 5-second cache in the temp directory.
- `config.ts`: environment-variable settings.
- `fixtures.spec.ts`, `render.spec.ts`, `git.spec.ts`, `main.spec.ts`: `bun test statusline`.
  The recorded cases live in `tests/fixtures/statusline/`.
- `subagent.ts`: entry point for the subagent rows. It shares the palette, glyphs and width
  helpers exported by `render.ts`.
- `launcher.ts`: setup copies it to `~/.claude/omca/statusline.ts`, outside the plugin, so it
  imports nothing relative. It runs `main.ts`, or `subagent.ts` with `--subagent`, from the newest
  installed plugin version.
- `subagent.spec.ts`, `launcher.spec.ts`: run the entry points as processes and compare stdout.

## Conventions

The renderer reads `.omca/state/boulder.json` directly because it runs outside any tool call,
and resolves the plan through `src/core/boulder.ts` with `strict` set, so a session without
its own binding never shows another session's plan. It never writes the file.

Rounding of exact binary ties goes to the even neighbour (`fixed` in `render.ts`). The recorded
fixtures need it, so do not replace it with `toFixed` or `Math.round`.
