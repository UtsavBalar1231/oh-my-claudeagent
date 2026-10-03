# Statusline

The main status line and the per-subagent tasks panel renderers for Claude Code, in TypeScript
on bun. Read `README.md` first for what they show and how they are configured.

## Layout

- `main.ts`: entry point. Reads the payload from stdin, reads git, prints the render, and
  prints `[claude]` when anything fails.
- `render.ts`: payload types, the segments and the layout. `render(data, git, env, now)` takes the
  environment and the clock as arguments so specs control both. `arrange` fills lines with
  `Segment` values (a `min` and `max` width in cells, and a `draw` for a given width) in priority
  order; `subagent.ts` calls it too. `fullRows` gives the session, workspace and usage rows, and
  `stackRows` starts each on its own line, wraps it with `arrange`, and while the lines run past
  the budget drops the segment with the highest `RANK` in any row.
- `git.ts`: branch, status counts, remote, and the 5-second cache in the temp directory.
- `fixtures.spec.ts`, `render.spec.ts`, `git.spec.ts`, `main.spec.ts`: `bun test statusline`.
  The recorded cases live in `tests/fixtures/statusline/`; each case also asserts that no line
  is wider than its `COLUMNS` minus 6 and that no segment is cut.
- `subagent.ts`: entry point for the subagent rows. It shares the palette, glyphs and width
  helpers exported by `render.ts`.
- `launcher.ts`: setup copies it to `~/.claude/omca/statusline.ts`, outside the plugin, so it
  imports nothing relative. It runs `main.ts`, or `subagent.ts` with `--subagent`, from the
  enabled install that `plugins/installed_plugins.json` records most recently, under any
  marketplace name and version.
- `subagent.spec.ts`, `launcher.spec.ts`: run the entry points as processes and compare stdout.

## Conventions

The renderer reads `.omca/state/boulder.json` directly because it runs outside any tool call,
and resolves the plan through `src/core/boulder.ts` with `strict` set, so a session without
its own binding never shows another session's plan. It never writes the file.

The renderer takes no tuning settings. `COLUMNS` and `LINES` from Claude Code size the layout.
Lines use `COLUMNS` minus the 3 cells Claude Code keeps free on each side, measured in a live
session. The only override is `CLAUDE_STATUSLINE_NERD_FONT=0`. `subagent.ts` also reads
`OMCA_SUBAGENT_STATUSLINE_DUMP`: when set, it appends each raw payload to that file, for
recording fixtures. A new segment is an entry in its row in `fullRows`, at its priority
position, built as a `block` when its width is fixed, with an entry in `RANK` that says when it
gives way. Keep a segment whole: only the next-task label may be ellipsized, and only the context
bar may change width. The bar's 8 to 20 block range and the 60 and 85 percent color thresholds are
constants in `render.ts`.

Rounding of exact binary ties goes to the even neighbor (`fixed` in `render.ts`). The recorded
fixtures need it, so do not replace it with `toFixed` or `Math.round`.
