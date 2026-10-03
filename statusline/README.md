# Statusline

Renders the Claude Code status line from the JSON payload on stdin: model, plan progress,
context usage, git state, cost, duration and usage limits, with ANSI colors and optional Nerd
Font glyphs. It lays itself out from the size of the terminal and takes no tuning settings. The
renderer runs on bun and has no dependencies.

---

## What it shows

From 60 columns up the status line is three rows, each starting on its own line:

1. **Session:** model and effort, the vim mode when vim mode is on (setup hides the platform's
   own mode indicator, so this is the only one), the active agent, and plan progress for the plan
   bound to the session with the label of its next open task.
2. **Workspace:** the context window bar with its percentage and window size, the git branch
   with modified, staged and untracked counts, the project directory name (linked to the remote
   when there is one), the worktree name with the branch it came from, the pull request number
   with its review state, lines added and removed, and extra directories added to the session.
   A red `!` follows the percentage when the context passes 200k tokens on a 200k window, and a
   session in a worktree shows the worktree's branch.
3. **Usage:** the session cost and duration, the 5 hour and 7 day usage limits, each with a bar
   and its reset time, and the spend limit.

Each segment appears only when it has something to show, and a row with nothing to show is left
out. A 200 column terminal shows each row on one line:

```
> Opus 5.5 · E: high · A: oh-my-claudeagent:executor · T: 2/4 -> Wire the order summary panel into the payment step and cover it with a test
▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱ 34%  200k · * feature/checkout-redesign ~3  +2  ?1 · > shop · W: checkout-wt <- main · #42 + · +42/-7 · +2 dirs
~ 2m05s · ▰▰▰▰▱▱▱▱▱▱ 45% 5h (resets 6pm) · ▰▰▰▰▰▰▰▰▱▱ 80% 7d (resets mon 5pm)
```

An 80 column terminal wraps the session row onto two lines, and to stay within four lines it
gives up the lowest-ranked segments (the worktree, pull request, lines changed, extra directories
and the 7 day limit) so the duration and the 5 hour limit stay:

```
> Opus 5.5 · E: high · A: oh-my-claudeagent:executor
T: 2/4 -> Wire the order summary panel into the payment step and cover it…
▰▰▰▰▰▱▱▱▱▱▱▱▱▱ 34%  200k · * feature/checkout-redesign ~3  +2  ?1 · > shop
~ 2m05s · ▰▰▰▰▱▱▱▱▱▱ 45% 5h (resets 6pm)
```

A terminal under 60 columns gets one compact line:

```
> Opus 5.5 · T: 2/4 · 34% · * main
```

The samples show the `unicode` glyphs. With Nerd Font glyphs, the default, each label is a glyph instead.

**Cost** shows only for an account billed by the token. The payload says nothing about the
account type, but `rate_limits` carries a `five_hour` or `seven_day` window only for Claude.ai Pro
and Max subscribers, so a payload with either window shows no cost. Otherwise the cost shows once
it is above zero, which also keeps a subscriber's first frames, before the first API response
brings the windows, from showing `$0.00`. Behind a Claude apps gateway that reports only a
`spend_limit`, the account is billed by spend and keeps its cost. The duration always shows.

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
- **Rows.** Each row starts on its own line, whatever the width. Within a row, segments fill the
  line in the order above, three cells apart. A segment that does not fit wraps whole to the next
  line of its row, and a segment is never cut. A segment wider than the terminal is skipped.
- **Lines run out.** A terminal under 20 rows gets at most two lines, any other at most four.
  When the rows need more, segments give way one at a time in a fixed order across all three
  rows, the least useful first: extra directories, lines changed, the spend limit, the 7 day
  limit, the pull request, the worktree, the vim mode, the agent, the directory, the 5 hour
  limit, the cost and duration, the branch, the context bar, then the plan. The model always stays.
- **The next-task label** is the only text that is ellipsized, to the room its line has. When
  fewer than 12 cells of label would fit, the whole plan segment wraps instead.
- **The context bar** is 8 blocks at the least and 20 at the most, and takes the free cells left
  on its line. Eight blocks keep the 60% and 85% color thresholds apart (one block is 12.5
  points), and past 20 blocks a block is under 5 points and the bar adds nothing.
- **Under 60 terminal columns** the output is one compact line of model, plan count, context percentage
  and branch, dropping from the right when they do not fit.
- **Colors and links.** Bars and percentages are green below 60%, yellow from 60% to 84% and red
  from 85%, fixed values. The branch and a subagent row's name draw in the terminal's default
  foreground, the name in bold, never in white, so they read on light and dark backgrounds.
  Links use OSC 8 and always close with their text.
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
goes through the launcher. It reads where Claude Code installed the plugin from
`~/.claude/plugins/installed_plugins.json`, under any marketplace name and version, skips an
install that `enabledPlugins` in `~/.claude/settings.json` switches off or that has no renderer
(an older install without `statusline/main.ts`), and runs `main.ts` from the most recently updated of the rest. The status line
therefore follows plugin updates without another setup run. `CLAUDE_CONFIG_DIR` replaces
`~/.claude` in those paths. With no installed version, as in a `--plugin-dir` checkout, it prints
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
| `OMCA_GLYPHS` | `nerd` | `nerd` draws Nerd Font glyphs, `unicode` the text labels below with Unicode bars and separators, `ascii` plain text throughout. An unknown value means `nerd`. The `/omca` pane reads the same variable. |
| `COLUMNS` | `80` | Terminal width in cells. Claude Code sets it. A value that is not a positive integer is ignored. |
| `LINES` | tall | Terminal height. Claude Code sets it. Under 20 the status line takes at most two lines. |
| `OMCA_SUBAGENT_STATUSLINE_DUMP` | unset | Path. Appends each raw `subagentStatusLine` stdin payload to this file as JSONL. Opt-in capture for answering platform-payload questions; no rotation. |

Without Nerd Font glyphs the renderer uses text labels: `*` for the branch, `>` for the model
and folder, `~` for the clock, `E:` for effort, `V:` for vim mode, `W:` for the worktree, `T:`
for plan progress, `5h` and `7d` for the usage windows. `ascii` also draws the bars with `#` and
`.`, separates segments with `|` and cuts with `...`.

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

Behind a Claude apps gateway with a spend limit, the payload can also carry
`rate_limits.spend_limit`:

```json
{
  "rate_limits": {
    "spend_limit": { "used_percentage": 62.8, "resets_at": 1738857600, "used_usd": 314.12, "limit_usd": 500, "period": "monthly" }
  }
}
```

The spend segment reads `$314.12/$500 mo` after the usage windows, with a leading `S:` or a Nerd
Font glyph. `period` reads `day`, `wk` or `mo` for `daily`, `weekly` or `monthly`. The segment
needs both `used_usd` and `limit_usd`, which the gateway reports separately and can leave out,
so a `spend_limit` with only a percentage draws nothing. It takes the same green, yellow and red
thresholds as the context bar from `used_percentage`, or from the dollars when no percentage came.

---

## Git info

`git.ts` reads the branch from `.git/HEAD` directly, resolving the git directory from the `.git`
file in a linked worktree, and runs `git status --porcelain=v2 -u` for the staged,
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
| `launcher.ts` | Copied to `~/.claude/omca/statusline.ts`; runs the renderer of the enabled install Claude Code updated last. |
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
`${CLAUDE_PLUGIN_ROOT}` in its command nor sets that variable for it (measured), so a
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
payload's `columns`, then `COLUMNS`, then 80, on one line: segments are added in the order name,
model, status, effort, context, and the first one that does not fit is dropped along with every
later one. Only a name wider than the row is cut. Any unreadable input prints nothing, so the tasks
panel keeps its default rows.

---

## Agent icons

With Nerd Font glyphs on, the status line and the `/omca` pane show an icon next to the agent name. The lookup strips
the `oh-my-claudeagent:` prefix (`oh-my-claudeagent:sisyphus` resolves to `sisyphus`), and any
name outside the table falls back to `nf-fa-user`.

| Agent | Glyph | Theme |
|-------|-------|-------|
| sisyphus | nf-fa-repeat | the endless task |
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
