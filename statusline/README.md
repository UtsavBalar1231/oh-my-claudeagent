# Statusline

Renders the Claude Code status line from the JSON payload on stdin: model, plan progress,
context usage, git state, cost, duration and usage limits, with ANSI colors and optional Nerd
Font glyphs. It lays itself out from the size of the terminal and takes no tuning settings. The
renderer runs on bun and has no dependencies.

---

## What it shows

In a git project with an active session, an 80 column terminal gets four lines. The 7 day
limit, the lines changed and the extra directories are the lowest segments and do not fit:

```
> Opus 5.5 · E: high · T: 2/4 -> Wire the order summary panel into the pa…
▰▰▰▰▰▱▱▱▱▱▱▱▱▱ 34%  200k · * feature/checkout-redesign ~3  +2  ?1 · > shop
A: oh-my-claudeagent:executor · W: checkout-wt <- main · #42 +
$1.50 · ~ 2m 5s · ▰▰▰▰▱▱▱▱▱▱ 45% 5h (resets 6pm)
```

A 200 column terminal holds every segment on two lines, and a terminal under 60 columns gets one
compact line:

```
> Opus 5.5 · T: 2/4 · 34% · * main
```

The samples show the ASCII glyphs. With Nerd Font glyphs on, each label is a glyph instead.

The segments, in priority order. Each appears only when it has something to show.

1. Model and effort, then the vim mode when vim mode is on (setup hides the platform's own mode
   indicator, so this is the only one).
2. Plan progress for the plan bound to the session, with the label of its next open task.
3. Context window bar with its percentage and window size. A red `!` follows the percentage when
   the context passes 200k tokens on a 200k window.
4. Git branch with modified, staged and untracked counts. A session in a worktree shows the
   worktree's branch.
5. Project directory name, linked to the remote when there is one.
6. Active agent, worktree name with the branch it came from, and pull request number with its
   review state, each its own segment.
7. Session cost and duration.
8. Usage limits: the 5 hour window, then the 7 day window, each with a bar and its reset time.
   They are absent from the payload for everyone but Claude.ai Pro and Max subscribers, and until
   the first API response.
9. Lines added and removed.
10. Extra directories added to the session.

The status line leaves out what stays constant within a session, repeats another segment, or has
a command of its own: the thinking marker, the session name or id, the client version, the output
style name and its restore tip, the token total, the API time and the repository name (the
directory links to the remote, and the pull request carries its number). `/omca doctor` reports
the client version.

On any unreadable input, or a payload without a model, the output is `[claude]`.

---

## How it adapts

Claude Code sets `COLUMNS` and `LINES` before it runs the command. A missing or invalid `COLUMNS`
reads as 80. A missing or invalid `LINES` reads as a tall terminal. Widths are terminal cells, so
a wide character such as a CJK glyph counts as two.

- **Margins.** Claude Code keeps 2 cells of its own plus the 1 cell of `padding` that setup
  writes free on each side of the status line, and clips whatever runs into them. Every line is
  therefore laid out in `COLUMNS` minus 6 cells.
- **Fill by priority.** Segments fill lines in the order above, three cells apart. A segment that
  does not fit wraps whole to the next line, and a segment is never cut. A segment wider than the
  terminal is skipped.
- **Lines run out.** A terminal under 20 rows gets at most two lines, any other at most four.
  When the lines are full, the segment that did not fit and every lower one are dropped.
- **The next-task label** is the only text that is ellipsized, to the room its line has. When
  fewer than 12 cells of label would fit, the whole plan segment wraps instead.
- **The context bar** is 8 blocks at the least and 20 at the most, and takes the free cells left
  on its line. Eight blocks keep the 60% and 85% color thresholds apart (one block is 12.5
  points), and past 20 blocks a block is under 5 points and the bar adds nothing.
- **Under 60 terminal columns** the output is one compact line of model, plan count, context percentage
  and branch, dropping from the right when they do not fit.
- **Colors and links.** Bars and percentages are green below 60%, yellow from 60% to 84% and red
  from 85%, fixed values. Links use OSC 8 and always close with their text.
- **A model name wider than a line** is the one case that is cut, because the line must still fit.

---

## Running it

```bash
echo '{"model": {"display_name": "Opus 5.5"}, "context_window": {"used_percentage": 42}}' \
  | bun statusline/main.ts
```

`/oh-my-claudeagent:omca-setup` registers it. It copies `launcher.ts` to
`~/.claude/omca/statusline.ts` (under `CLAUDE_CONFIG_DIR` when it is set) and, after you confirm
the printed diff, sets the `statusLine` key in `~/.claude/settings.json`. Both paths are written
in forward-slash form and double-quoted, so a path with spaces or a Windows drive survives:

```json
"statusLine": {
  "type": "command",
  "command": "\"/home/you/.bun/bin/bun\" \"/home/you/.claude/omca/statusline.ts\"",
  "padding": 1,
  "refreshInterval": 5,
  "hideVimModeIndicator": true
}
```

A plugin `settings.json` cannot carry `statusLine` (Claude Code drops the key), so the command
goes through the launcher. It runs `main.ts` from the newest version directory under
`~/.claude/plugins/cache/omca/oh-my-claudeagent/`, comparing version numbers numerically, so the
status line follows plugin updates without another setup run. `CLAUDE_CONFIG_DIR` replaces
`~/.claude` in that path. With no installed version, as in a `--plugin-dir` checkout, it prints
`omca: no installed plugin version found`.

`refreshInterval: 5` re-runs the command every 5 seconds, which keeps disk-sourced state (git
status and plan progress) current while the session sits idle between background-agent
fan-outs. The value matches the git cache lifetime, so each tick can pick up a fresh git
snapshot. It controls how often the platform runs the command, not how the renderer computes
any field.

---

## Configuration

The layout, bar widths, color thresholds, git cache lifetime (5 seconds) and git timeout (3
seconds) are fixed in the code. These environment variables are read:

| Variable | Default | Effect |
|---|---|---|
| `CLAUDE_STATUSLINE_NERD_FONT` | `1` | `1` uses Nerd Font glyphs, anything else uses ASCII. Set `0` when the terminal font has no Nerd Font glyphs, or for plain-text output. |
| `COLUMNS` | `80` | Terminal width in cells. Claude Code sets it. A value that is not a positive integer is ignored. |
| `LINES` | tall | Terminal height. Claude Code sets it. Under 20 the status line takes at most two lines. |
| `OMCA_SUBAGENT_STATUSLINE_DUMP` | unset | Path. Appends each raw `subagentStatusLine` stdin payload to this file as JSONL. Opt-in capture for answering platform-payload questions; no rotation. |

Without Nerd Font glyphs the renderer falls back to ASCII: `*` for the branch, `>` for the model
and folder, `~` for the clock, `E:` for effort, `V:` for vim mode, `W:` for the worktree, `T:`
for plan progress, `5h` and `7d` for the usage windows.

---

## Plan segment

The plan segment shows `<done>/<total>` for the plan bound to the session, followed by the label
of its first open task. The label is cut to 80 characters when the plan is read, and further to
fit its line. The segment resolves through `src/core/boulder.ts` in strict
mode: it appears only when `.omca/state/boulder.json` has a binding for the payload's
`session_id` whose plan file still exists and has an open numbered task. A session with no
binding shows nothing, and so does a plan with every task checked. The renderer only reads the
registry.

---

## Usage limits

The usage-limit segments come from the `rate_limits` field of the payload:

```json
{
  "rate_limits": {
    "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
    "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
  }
}
```

Each window is independent and `resets_at` is Unix epoch seconds. A reset later today reads
`5pm`, any other day reads `thu 5pm`, both in the local time zone. A window without
`used_percentage` is skipped, and with neither window there is no segment.

---

## Git info

`git.ts` reads the branch from `.git/HEAD` directly, resolving the git directory from the `.git`
file in a linked worktree, and runs `git status --porcelain=v2 --branch -u` for the staged,
modified, and untracked counts. The `origin` URL comes from `git remote get-url origin`, which
honors `url.insteadOf` rewrites and `includeIf` config, and is re-read at most once a minute.
SSH remotes (`git@host:user/repo.git`) become HTTPS for the link on the directory name.

The result is cached for 5 seconds in `<tmpdir>/omca-statusline-git-<hash>`, where the hash comes from the project directory path.
Status and remote run at the same time.

---

## Source layout

| File | Purpose |
|---|---|
| `main.ts` | Entry point: reads stdin, reads git, prints the render. |
| `render.ts` | Payload types, the segments, the layout (`arrange`), and every formatting helper. |
| `git.ts` | Branch, status counts, remote, and the cache. |
| `subagent.ts` | Entry point for the subagent rows. |
| `launcher.ts` | Copied to `~/.claude/omca/statusline.ts`; runs the newest installed renderer. |
| `*.spec.ts` | `bun test statusline`. |

`fixtures.spec.ts` renders every case in `tests/fixtures/statusline/`, compares it byte for byte
with the recorded `.txt` file beside it, and checks that no line is wider than the case's `COLUMNS` minus 6
(wide characters count as two) and that no segment is cut. The `width-*` cases run one rich payload
at 40, 60, 80, 120 and 200 columns and `height-15` at 15 rows. A case with `lastResortCut` set
skips the cut check. A case with `repo` runs `main.ts` against a real
git repository the spec builds; every other case calls `render` with a fixed clock
(`2026-10-02T12:00:00Z`, UTC) and the git state written in the case. Cases with `files` have those
files written under the temporary root first. After an intended change to the output, rewrite the
affected `.txt` files and review the diff.

Rounding follows round-half-to-even for exact binary ties (`72.5%` reads `72%`, `$0.125` reads
`$0.12`), which `toFixed` and `Math.round` do not.

---

## Per-subagent status line

`subagentStatusLine` is separate from `statusLine`: it renders one row per active subagent in the
tasks panel instead of one line for the main session. `subagent.ts` renders it, reached through
the same launcher with `--subagent`, which setup writes beside `statusLine`:

```json
"subagentStatusLine": {
  "type": "command",
  "command": "\"/home/you/.bun/bin/bun\" \"/home/you/.claude/omca/statusline.ts\" --subagent"
}
```

A plugin `settings.json` does keep `subagentStatusLine`, but Claude Code neither substitutes
`${CLAUDE_PLUGIN_ROOT}` in its command nor sets that variable for it (measured on 2.1.287), so a
plugin-relative command cannot find its script.

**Input** (stdin): one JSON object with a `tasks` array (each task carries `id`, `name`, `type`,
`status`, `description`, `label`, `startTime`, `model`, `effort`, `contextWindowSize`,
`tokenCount`, `tokenSamples`, `cwd`) and a `columns` field.

`effort` is the reasoning effort configured for that subagent. Its shape differs from the main
status line's `effort`, which is a `{"level": "high"}` dict: the per-task field is a bare value,
either one of `low`/`medium`/`high`/`xhigh`/`max` or a numeric token budget. It is absent when
the subagent inherits the session level, and the row renders no effort token then since the main
line already shows the session value.

`contextWindowSize` is the resolved model's context window in tokens, omitted while the task's
model is unresolved. When present, the row shows `tokenCount` as a percentage of it, which is
comparable across rows running on different windows. When absent, the row falls back to the raw
compact token count.

**Output** (stdout): one JSON line per task to override its row,
`{"id": "<task id>", "content": "<row body>"}`.

Each row shows the agent name with any namespace prefix stripped and its themed glyph, the model,
the status, the configured effort, and context usage. A task without a `name` shows its `label`,
then its `type`. The model is the task's own `model` field; when that is absent, a task named
`oh-my-claudeagent:<agent>` takes the tier from that agent's frontmatter. A row fits the
payload's `columns`, then `COLUMNS`, then 80, by the same rule as the main line: segments are
added in the order name, model, status, effort, context, and the first one that does not fit is
dropped along with every later one. Only a name wider than the row is cut. Any unreadable input prints nothing, so the tasks
panel keeps its default rows.

---

## Agent icons

With Nerd Font glyphs on, the status line shows an icon next to the active agent name. The lookup strips
the `oh-my-claudeagent:` prefix (`oh-my-claudeagent:sisyphus` resolves to `sisyphus`), and any
name outside the table falls back to `nf-fa-user`.

| Agent | Glyph | Theme |
|-------|-------|-------|
| sisyphus | nf-fa-mountain | boulder-pushing myth |
| prometheus | nf-fa-fire | stolen flame |
| metis | nf-fa-search | gap analysis |
| momus | nf-fa-comment | critique |
| oracle | nf-fa-eye | foresight |
| executor | nf-fa-cogs | the doer |
| explore | nf-fa-compass | exploration |
| librarian | nf-fa-book | library |
| hephaestus | nf-fa-wrench | smith |
| multimodal-looker | nf-fa-camera | visual input |

The glyphs come from the `nf-fa-*` Font Awesome range, which is stable across Nerd Fonts v2 and
v3, so both versions show the same icons.
