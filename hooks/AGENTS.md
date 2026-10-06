# Hook inventory

`hooks/hooks.json` is the canonical hook registry. Query it directly for counts.

## Hook events

Registered here: `SessionStart`, `UserPromptSubmit`, `UserPromptExpansion`,
`SubagentStart`, `PreToolUse`, `PermissionDenied`, `PostToolUse`,
`PostToolUseFailure`, `Stop`, `TaskCompleted`.

Regenerate that list with `jq -r '.hooks | keys[]' hooks/hooks.json`. Every other platform
event is unregistered on purpose; `docs/references.md` carries the per-event reason.

## The mod

`register.ts` is the only file that calls `on()`. It gives each event one dispatcher from
`dispatch.ts`, which runs the features that share the event in a fixed order, each in its own
try/catch. `host.ts` defines the `Host` closures a feature receives in place of `$`, so a
feature module takes `host` and never `$`. The features are `bash-guard`, `server-check`,
`mod-marker`, `compact`, `route`, `agents-tracker`, `metrics`, `band`, `pane` with its `tabs/`,
`footer`, `spinner`, `feedback` and `omca-router`. `doctor.ts` runs the Doctor tab's checks and fixes for
`tabs/doctor.ts`; it registers no event. Pure logic lives in `src/core/`.

`spinner` rewrites only the `suffix` of the terminal's main-loop Spinner, to `… · task 7/14 · 3 agents`,
from the band and agents atoms. A Spinner whose `requestId` is a tracked agent id, and every desktop
Spinner, pass through unchanged.

`agents-tracker` also owns the agent page that `tabs/agent-page.ts` draws on the Agents tab: a
Button keyed `open-<agent id>` on each lane opens it, and `b`, `c` and `r` go back, copy the brief
and reload. Its one `tool.call` registration passes a main-loop call through untouched and, for a
subagent's call, appends the call and its outcome to a module-level map, with no state write. The
`pages` atom is written only when a page is opened, on `r` and at the agent's `turn.complete`,
from `$.session.messages({ agentId })` and that map; a denied read keeps the stored prompt. A
page holds at most 8 KiB of brief, 120 calls and 4 KiB of reply, for the newest 20 agents.

`mascot-player` animates the mascots of `src/core/mascots.ts`: the 8 by 4 mini that leads each
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
never starts it; on Desktop an Svg animates by itself and no timer runs.

## Current runtime contract

- `UserPromptSubmit` and `UserPromptExpansion` route to the server's `keyword-detector` and
  `slash-mode-detector` handlers, and both to its `guidance` handler, which injects the
  guidance template, the session id and the bound plan's context on a session's first prompt.
- The mod and the server each report when the other is missing. At `session.start` the mod's `server-check.ts`
  asks the engine to connect the `omca` server and, when it is not connected, writes one line
  to the transcript: that bun is not on PATH, or the engine's reason with a pointer to `/mcp`.
  On the launch session's first prompt, the server's `mod-notice` handler answers with a
  `systemMessage` when the mod has written no marker for the session. A session that `/clear`
  starts is marked only at its first `turn.start`, after the prompt hook, so the handler never
  judges it. `OMCA_DISABLED_HOOKS=mod-notice` silences the server's line.
- `SessionStart` for `clear` or `compact` routes to the server's `session-start` handler,
  which re-injects that context after a compaction and hands it back to the next prompt
  after `/clear`. The mod's `session.compact` feature (`compact.ts`) tells the summarizer to
  keep the bound plan and its open tasks.
- `SubagentStart` routes to the server's `subagent-context` handler, and `PermissionDenied`
  to its `permission-coach` handler, which answers an auto-mode classifier denial of a Bash
  call with `retry: true`.
- `Stop` routes to the server's `stop-gates` handler, which runs plan continuation, final
  verification, and the drift guard in that order and answers with the first block.
  `OMCA_DISABLED_HOOKS=stop-gates` turns off all three; `plan-continuation`,
  `final-verification`, or `drift-guard` turns off one.
- The destructive-command guard lives in the mod, on `tool.check` for Bash and PowerShell
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
  a separator. `tool.check` runs before every Bash and PowerShell call in every permission mode,
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
  type. Start-up pruning and the exit unbind run in the server process, outside any hook.
