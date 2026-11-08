# Hook inventory

`hooks/hooks.json` is the canonical hook registry. Query it directly for counts.

## Hook events

Registered here: `SessionStart`, `UserPromptSubmit`, `UserPromptExpansion`,
`SubagentStart`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`,
`TaskCompleted`.

Regenerate that list with `jq -r '.hooks | keys[]' hooks/hooks.json`. Every other platform
event is unregistered on purpose; `docs/references.md` carries the per-event reason.

## The mod

`register.ts` is the only file that calls `on()`. It gives each event one dispatcher from
`dispatch.ts`, which runs the features that share the event in a fixed order, each in its own
try/catch. `host.ts` defines the `Host` closures a feature receives in place of `$`, so a
feature module takes `host` and never `$`. The features are `bash-guard`, `server-check`,
`mod-marker`, `agents-tracker`, `agent-rows`, `metrics`, `band`, `pane` with its `tabs/`, `footer`,
`group-rows`, `keyword-paint`, `completion`, `refusal-recovery`, `omca-router`, `task-tools`,
`task-list` and `task-rows`. `doctor.ts` runs the Doctor page's checks and fixes for `tabs/doctor.ts`; it registers
no event. Pure logic lives in `src/core/`.

The mod's only view of planned work is Claude Code's native task list. State is the task files under
`<config dir>/tasks/<list id>/`; the mod has no plan file format, parser or registry, and it keeps
OMCA's task view in one pane. The band shows a run line while a run has open tasks, and `task-rows`
writes one transcript row per main turn that changed a run, since Claude Code draws nothing for the task
tools' calls. The spinner carries no task facts.

`task-tools` turns the task tools on and names the checkout's list at `session.start`, each only
where nothing has set its variable, and the marker reports the list id as `task_list`.

`task-list` is its own pane, `tasklist`, opened by `/tasklist`, apart from the `omca` pane. The list
reads into the `tasks` atom at `session.start`, after each `TaskCreate` and `TaskUpdate`, at each main
`turn.complete`, and from a 2 s timer while the pane is open. It keeps finished tasks whose files
Claude Code deleted. The head names the run, its done count and a progress bar. Rows group as
Running, Ready, Blocked, Waiting and Done under labeled rules, each with its state mark; the final
task sits last in its group. A running row's aside is its owner and a waiting row's is its first open
blocker; a blocked task's reason gets its own row. Done, other runs and run-less tasks fold to one row
each. Enter or a click opens a task's page, which lists its links, each with its mark, before the
description; the final task's page shows the newest verdict naming it, read from the ledger as the
page opens. Blank rows go first and then the counts row when the pane runs short. Closing the pane
stops the timer and forgets its place without touching the `omca` pane.

Three features redraw Claude Code's own transcript rows on the terminal, and every other surface
keeps the engine's rows. None of them reads a file during a drawing, and the row hooks read only
atoms written once per turn or per finished agent, since a row subscribes to every atom it reads.

- `footer` keeps each main turn's tokens, cost, verification receipt and the agents still running
  in the `turns` atom at `turn.complete`, and draws them in the `TurnDuration` line. A line belongs
  to the main turn that started last before the line was first drawn (`turn.start` times, kept in
  the module), so a turn that ends before the previous turn's facts land still draws its own; a
  line first drawn before any start, as after /resume, and a line whose turn has no record yet keep
  the engine's.
  The line names the agents the engine lists in `waitingFor`. The engine keeps its own line, with
  the facts on a row beneath, in the ctrl+o view (`isExpanded`), while the turn waits on a
  workflow, and while agents run that the props do not name, as from a client older than
  `waitingFor`. A session without a terminal gets the facts as the `turn.complete` text instead.
- `agent-rows` redraws the `ToolUse` row of a single Agent call from its own input (registered
  with `props: { tool: "Agent" }`, so no other tool row reaches the mod); several agents
  launched together are one engine block no hook reaches. It also keeps a finished subagent's
  type, task, status, duration, call count, tokens and the first line of its reply in the
  `notices` atom at the agent's `turn.complete`, after `agents-tracker` has closed its row, and
  redraws the `UserMessage` row of origin `task-notification` whose `task.id` it holds.
  `isExpanded` (ctrl+o) keeps the engine's rows.
- `group-rows` appends rows under a folded `ToolGroup`, read from its calls' own output: one per
  verification call (`isVerificationCommand`), and for a Read that returned a PNG a name row and
  an `Image` of the picture (the first three per group; the rest keep the name row). A picture
  whose bytes do not open as a PNG keeps its name row, since one bad `Image` refuses the whole
  tree. The previews share one tree's 2 MiB of picture bytes, the first first, and one that no
  longer fits is passed as its file. After the first picture of each kind it draws, bytes or a file,
  the feature blits it once: a refusal that names the alt means the terminal shows that kind only as
  text, and every later preview of that kind is the name row alone. tmux and iTerm2 3.5 and later
  draw bytes and not a file, and a refusal carrying `fix: "tmux-passthrough"` writes one transcript
  line naming tmux's `allow-passthrough` and `focus-events`.
  An expanded group is left as drawn.

`task-rows` places one row with `$.ui.place` under the turn line of a main turn that changed a run's
tasks, found by comparing the `tasks` atom at that turn's `turn.start` with the atom at its
`turn.complete`, after `task-list` has read the list. A subagent's turn places none. The row's facts are
fixed when it is placed and held in the `placedRows` atom, which survives a module reload and is written only
when a row is placed, so rows do not redraw on the `tasks` atom's 2 s writes. A row that does not stand drops
its facts.

`keyword-paint` underlines what the server's `keyword-detector` would match in the draft, from the
same `keywordSpans` reader in `src/core/keywords.ts`, only with `enableKeywordTriggers` on and that
detector's switch off. A `prompt.edit` answer carries the runs as typing goes on, and `prompt.change`
repaints with `$.prompt.read` and `$.prompt.paint` for a write no edit carries, as a recalled entry
or an undo. It notes a mode at `prompt.submit` as the detector announces it, once a session, and
stops marking it. `$.prompt.paint` rejects on an old client and leaves the draft as it stands.

`server-check` also keeps a `$.ui.status` line while the `omca` server is not connected, which the
engine draws under the prompt as `⚠ oh-my-claudeagent: ...`. Each main `turn.start` asks the engine
again, since a server can die after it connected and no event says so. It asks from a `$.clock.after`
timer and one ask at a time, so a server that hangs while it connects holds up no turn. The answer
is the session's state, and a failed server stays failed until `/mcp` reconnects it.

`agents-tracker` also owns the agent page that `tabs/agent-page.ts` draws on the Agents tab: a
Button keyed `open-<agent id>` on each lane opens it, and `b`, `c`, `r` and `v` go back, copy the
brief, reload and put the agent's transcript in the main view (`v` reads "Back to main" while that
agent is in view). Its one `tool.call` registration matches `{ agentId: /./ }`, so only a subagent's
call reaches the mod and a main-loop call never does. It appends the call and its outcome to a
module-level map, with no state write. The `pages` atom is written only when a page is opened, on
`r` and at the agent's `turn.complete`, from `$.session.messages({ agentId })` and that map; a
denied read keeps the stored prompt. A page holds at most 8 KiB of brief, 120 calls and 4 KiB of
reply, for the newest 20 agents.
An `agent.spawn` carrying `resume` whose agent already has a row reopens that row and lane instead
of building new ones: the row goes back to running with no end time and keeps its start, tokens and
cost, the lane keeps its prompt and call count and clears its tool, output and result, and a
module-level map holds the row's tokens so the next completion adds its usage to them. `metrics`
rewrites that agent's record as running with the same tokens.

`mascot-player` animates the mascots of `src/core/mascots.ts`: the 15 by 4 mini that leads each
relaxed lane on the Agents tab, drawn when the body holds every running lane, a row after each, the
Finished label and the one-line rows (the latest wave's finished agents keep their lanes and still
minis while rows remain), and the 16 by 8 mascot in the agent page header. The compact
lanes and the ASCII tier draw none. `show` records the size each drawing laid out, so a blit
matches the mounted Raster. On a terminal the pane's tick
and its open paths call `ensure`, which starts one `$.clock.every(FRAME_MS)` timer while a laid-out
agent works. Each tick advances a module-level frame counter and awaits a `$.ui.blit` of each shown
working mascot, and a denied blit is a mascot that is not mounted. The render hooks pass `frame()` to
`kit.mascot`, so a redraw lands on the frame the blits are at. The timer ends when no shown agent
works, the pane closes or the surfaces lose `terminal`; a stop from the timer's own tick redraws the
pane once, so a blit in flight never outlasts the still frame. It writes no atom and a `ui.render` hook
never starts it. No timer runs on a remote surface: Desktop draws a still Svg, since it rebuilds
every site on each state write and would restart an animation, and the other remote surfaces
animate the Svg by themselves.

The UI kit (`ui.ts`) always sends the typeset props. Its `Text` sends `weight: "semibold"` in
place of `bold: true`, and on a remote surface `Run` sets `mono` on its container and every span,
a `Text` outside `Run` that holds a digit sets `tabular`, and the row gaps of the pane and its
tabs and the band's button gap are the named steps `"md"` and `"lg"` in place of cells. The
terminal keeps its cell gaps. `resolveSession` (`host.ts`) does not read the engine version.

Each pane's `ui.scroll` hook reads that pane's committed layout (`regions.ts`). Each terminal drawing
collects its own on `view.layout`: every scroll region and every list that draws its own window,
with its rect in the tab's rows and columns, the tab rows above the tab, the engine's offset it
drew at, whether the pane padded the tree, and the rows the tree takes. The drawing commits it in
one assignment when it finishes, and one that started earlier never replaces a newer commit,
because the engine raises `ui.render` and `ui.scroll` concurrently and a drawing awaits its tab.
Region offsets are module state that outlives drawings. A wheel tick, the one event that carries
`pointer`, moves only what is under it: a region by `by` rows, else a list by `by` rows, each
clamped and taking the tick at its end. Over nothing it reaches the engine only while the tree is
taller than the body by more than the padding row, and is taken with no effect otherwise. Routing
never reads the size of `by`, since the engine merges ticks in flight into one move. The scroll
keys carry no `pointer` and keep their own routing: the tab's list, then the aimed or first
overflowing region, a row, a page (`bodyRows`) or an end (`contentRows`) at a time.

## Current runtime contract

- `refusal-recovery` handles only interactive, user-origin main turns whose structured
  `turn.complete` refusal category is `reasoning_extraction`, which reaches the mod only after
  Claude Code's own once-only retry was refused too. It queues one plugin-authored follow-up
  after completion asking for conclusions, evidence and actions in place of reasoning,
  preserves the refusal result, and does not recover the follow-up's own turn. A new user
  prompt or edit cancels a follow-up before it is queued; competing turns after queueing are not
  recovered. Every other category (`cyber`, `bio`, `frontier_llm`) is left to the person, and
  `OMCA_DISABLED_HOOKS=refusal-recovery` turns the feature off. The engine validator allows
  `prompt.submit` only through the Host binding in `register.ts` and this feature;
  `model.fork`, `http.fetch` and `store.*` remain forbidden.

- `UserPromptSubmit` and `UserPromptExpansion` route to the server's `keyword-detector` and
  `slash-mode-detector` handlers, and both to its `guidance` handler, which injects the
  guidance template, the session id and the open run's context on a session's first prompt.
- The mod and the server each report when the other is missing. At `session.start` and each main `turn.start`
  the mod's `server-check.ts` asks the engine to connect the `omca` server and, when it finds it not connected, writes one line
  to the transcript: that bun is not on PATH, or the engine's reason with a pointer to `/mcp`.
  On the launch session's first prompt, the server's `mod-notice` handler answers with a
  `systemMessage` when the mod has written no marker for the session. A session that `/clear`
  starts is marked only at its first `turn.start`, after the prompt hook, so the handler never
  judges it. `OMCA_DISABLED_HOOKS=mod-notice` silences the server's line.
- `SessionStart` for `clear` or `compact` routes to the server's `session-start` handler,
  which re-injects that context after a compaction and hands it back to the next prompt
  after `/clear`. The mod registers no `session.compact` hook: tasks persist across compaction
  natively, so its summary has nothing to restate.
- `SubagentStart` routes to the server's `subagent-context` handler.
- `Stop` routes to the server's `stop-gates` handler, which runs task continuation and the drift
  guard in that order and answers with the first block. `OMCA_DISABLED_HOOKS=stop-gates` turns off
  both; `task-continuation` or `drift-guard` turns off one.
- The destructive-command guard lives in the mod, on `tool.check` for Bash, PowerShell and Monitor
  (whose commands are bash: Monitor needs Git Bash on Windows)
  (`hooks/bash-guard.ts`, with its patterns in `src/core/destructive.ts`). A recursive removal
  whose target is the filesystem root, home, the working directory, or a directory directly
  under root or home is denied outright. The destructive git family (hard reset, stash, clean,
  a restore that writes the working tree, recursive `git rm`, path checkout), a force push to the
  default branch and `git commit --no-verify` are held for review and denied wherever no dialog
  can show. Any other recursive removal, an `xargs rm -rf` whose targets are not known, and a
  force push to another branch are held for review and run where no dialog can show. Where a
  dialog can show and the `guardMode` option is `dialog`, the guard asks the user, and only
  "Run it" lets the call continue. With `guardMode` set to `deny`, no dialog shows. The default
  branch is the one `origin/HEAD` names, or `main` and `master` when it names none, read from
  local refs. `OMCA_DISABLED_HOOKS=bash-guard` turns the review off and never the outright deny.

  The patterns match at any command position: string start, after a separator, or inside a
  subshell or command substitution, behind wrappers such as `sudo`, `env`, `command`, `timeout`
  and `xargs` and `VAR=value` prefixes. `rm` options and the options of `git reset`, `git rm`,
  `git restore` and `git commit` count wherever they stand before `--`. The guard also reads
  commands handed to another interpreter: `bash -c`, `sh -c`, `eval`, a heredoc fed to a shell,
  `pwsh -Command`, `cmd /c` and `Invoke-Expression` with a literal string. Anchoring on command position keeps a literal
  mention out of scope, since the `rm` in `grep -rn "rm -rf" scripts/` follows a quote rather than
  a separator. `tool.check` runs before every Bash, PowerShell and Monitor call in every permission mode,
  so the guard never depends on a dialog being shown. The platform's critical-path check on `rm`
  and `rmdir` asks in the terminal or denies in auto mode, and the classifier does not review
  those removals. That check covers critical paths only, while the guard also covers the
  destructive git family, force pushes and other recursive removals, so it must not be deleted
  as duplicated platform behavior.
- `tool.check` never returns an allow, because an allow there skips the auto-mode classifier.
  No OMCA hook returns an allow on any event: hooks deny, ask or steer, and allow decisions come
  from the permission rules in the user's settings. Nothing is registered on `PermissionRequest`.
  That event fires for a call that cannot prompt, such as `-p` outside `dontAsk`, which the
  platform would otherwise auto-deny, so a hook allow there would run a command the platform
  refuses. To cut prompts for a tool the user trusts, point them to an allow rule in settings or
  to `/fewer-permission-prompts`.
- Claude Code owns the hook lifecycle. OMCA supplies the mod's module and the
  `type: mcp_tool` handlers whose `tool` is `omca_hook`, and every registered handler is of that
  type. Start-up pruning runs in the server process, outside any hook.
