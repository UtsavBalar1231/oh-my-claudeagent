# Statusline

Renders the Claude Code status line from the JSON payload on stdin: model, plan progress, git
state, context usage, cost, duration, and usage limits, with ANSI colors and optional Nerd Font
glyphs. The renderer runs on bun and has no dependencies.

---

## What it shows

In a git project with an active session, the output is up to four lines:

```
> Opus 5.5 · E: high · T: 1/3 -> Wire up the widget · 11111111 · * main ~2 +1 · > my-project
▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 34%  200k · $0.12 · ~ 1m 42s · +87/-23
▰▰▰▱▱▱▱▱▱▱ 28% 5h (resets 4pm) · ▰▰▱▱▱▱▱▱▱▱ 18% 7d (resets thu 9am)
```

The sample shows the ASCII glyphs; with Nerd Font glyphs on, each label is a glyph instead.

**Line 1, context info**: model name, effort level, thinking marker, bound plan progress with
the next open task, session name or id (a link to the transcript when the payload has its path),
git branch and status counts, project directory name (a link to the remote when there is one),
extra directories, repository and pull request, active agent, worktree, output style, vim mode,
and the client version.

**Line 2, metrics**: context window usage bar with percentage and window size label, session
cost, total duration, lines added and removed, token total, API time.

**Line 3, usage limits**: 5-hour and 7-day utilization bars with reset times. Omitted when the
`rate_limits` field is absent from the payload, which happens for everyone but Claude.ai Pro and
Max subscribers before the first API response.

**Tip line**: shown when the output style is neither `default` nor OMCA Default, with the command
that restores it.

**Single-line fallback**: with no git repository, no agent, no worktree, no vim mode, and nothing
else extra on line 1, lines 1 and 2 collapse into one line holding the model, bar, cost, and
duration.

Progress bars are green below 60%, yellow from 60% to 84%, and red from 85%. A red `!` follows
the percentage when the context passes 200k tokens on a 200k window. Every line is cut to the
terminal width, so a long line never wraps.

On any unreadable input, or a payload without a model, the output is `[claude]`.

---

## Running it

```bash
echo '{"model": {"display_name": "Opus 5.5"}, "context_window": {"used_percentage": 42}}' \
  | bun statusline/main.ts
```

To register it with Claude Code, point the `statusLine` key in `~/.claude/settings.json` at the
script:

```json
"statusLine": {
  "type": "command",
  "command": "bun /path/to/statusline/main.ts",
  "padding": 1,
  "refreshInterval": 5,
  "hideVimModeIndicator": true
}
```

`refreshInterval: 5` re-runs the command every 5 seconds, which keeps disk-sourced state (git
status and plan progress) current while the session sits idle between background-agent
fan-outs. The value matches the git cache lifetime, so each tick can pick up a fresh git
snapshot. It controls how often the platform runs the command, not how the renderer computes
any field.

---

## Configuration

All configuration is by environment variable.

| Variable | Default | Effect |
|---|---|---|
| `CLAUDE_STATUSLINE_NERD_FONT` | `1` | `1` uses Nerd Font glyphs, anything else uses ASCII. Takes precedence over `NERD_FONT`. |
| `NERD_FONT` | `1` | Fallback preference when `CLAUDE_STATUSLINE_NERD_FONT` is not set. |
| `COLUMNS` | `80` | Terminal width the lines are cut to. A value that is not a positive integer is ignored. |
| `CLAUDE_STATUSLINE_BAR_WIDTH` | `20` | Width of the context bar in blocks. |
| `CLAUDE_STATUSLINE_THRESHOLD_WARN` | `60` | Percentage where bars turn yellow. |
| `CLAUDE_STATUSLINE_THRESHOLD_CRIT` | `85` | Percentage where bars turn red. |
| `CLAUDE_STATUSLINE_CACHE_TTL` | `5` | Seconds a git read is reused. `0` reads git on every render. |
| `CLAUDE_STATUSLINE_GIT_TIMEOUT` | `3` | Seconds before a git command is abandoned and its counts read as zero. |
| `OMCA_SUBAGENT_STATUSLINE_DUMP` | unset | Path. Appends each raw `subagentStatusLine` stdin payload to this file as JSONL. Opt-in capture for answering platform-payload questions; no rotation. |

Without Nerd Font glyphs the renderer falls back to ASCII: `*` for the branch, `>` for the model
and folder, `~` for the clock, `E:` for effort, `[T]` for thinking, `T:` for plan progress, `5h`
and `7d` for the usage windows.

---

## Plan token

Line 1 shows `<done>/<total>` for the plan bound to the session, followed by the label of its
first open task cut to 80 characters. The token resolves through `src/core/boulder.ts` in strict
mode: it appears only when `.omca/state/boulder.json` has a binding for the payload's
`session_id` whose plan file still exists and has an open numbered task. A session with no
binding shows nothing, and so does a plan with every task checked. The renderer only reads the
registry.

---

## Rate limits

Line 3 comes from the `rate_limits` field of the payload:

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
`used_percentage` is skipped, and with neither window there is no line.

---

## Git info

`git.ts` reads the branch from `.git/HEAD` directly, resolving the git directory from the `.git`
file in a linked worktree, and runs `git status --porcelain=v2 --branch -u` for the staged,
modified, and untracked counts. The `origin` URL comes from `git remote get-url origin`, which
honors `url.insteadOf` rewrites and `includeIf` config, and is re-read at most once a minute.
SSH remotes (`git@host:user/repo.git`) become HTTPS for the link on the directory name.

The result is cached for `CLAUDE_STATUSLINE_CACHE_TTL` seconds in
`<tmpdir>/omca-statusline-git-<hash>`, where the hash comes from the project directory path.
Status and remote run at the same time.

---

## Source layout

| File | Purpose |
|---|---|
| `main.ts` | Entry point: reads stdin, reads git, prints the render. |
| `render.ts` | Payload types, line composition, and every formatting helper. |
| `git.ts` | Branch, status counts, remote, and the cache. |
| `config.ts` | Environment-variable settings. |
| `*.spec.ts` | `bun test statusline`. |

`fixtures.spec.ts` renders every case in `tests/fixtures/statusline/` and compares it byte for
byte with the recorded `.txt` file beside it. A case with `repo` runs `main.ts` against a real
git repository the spec builds; every other case calls `render` with a fixed clock
(`2026-10-02T12:00:00Z`, UTC) and the git state written in the case. Cases with `files` have those
files written under the temporary root first. After an intended change to the output, rewrite the
affected `.txt` files and review the diff.

Rounding follows round-half-to-even for exact binary ties (`72.5%` reads `72%`, `$0.125` reads
`$0.12`), which `toFixed` and `Math.round` do not.

---

## Per-subagent status line

`subagentStatusLine` is separate from `statusLine`: it renders one row per active subagent in the
tasks panel instead of one line for the main session. It is still the Python renderer in
`subagent.py`, wired in `~/.claude/settings.json`:

```json
"subagentStatusLine": {
  "type": "command",
  "command": "~/.claude/statusline/.venv/bin/cc-statusline-subagent"
}
```

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

Each row shows the agent name with the namespace prefix stripped and its themed glyph, its real
model, status, configured effort, and context usage. The model comes from
`.omca/state/subagent-models.json`, which the SubagentStart hook writes: join on `task.id` to the
map key first, then fall back to a `task.name` or `task.type` match against `agent_type`. A task
with no entry renders without a model rather than failing, because the renderer only reads that
file and must never break the tasks panel.

---

## Agent icons

With Nerd Font glyphs on, line 1 shows an icon next to the active agent name. The lookup strips
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
