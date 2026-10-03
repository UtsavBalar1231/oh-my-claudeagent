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
`mod-marker`, `compact`, `route`, `agents-tracker`, `ledger`, `band`, `pane` with its `tabs/`,
`footer`, `doctor`, `feedback` and `omca-router`. Pure logic lives in `src/core/`.

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
  restore, recursive `git rm`, path checkout), a force push to the default branch and
  `git commit --no-verify` are held for review and denied wherever no dialog can show. Any other
  recursive removal, an `xargs rm -rf` whose targets are not known, and a force push to another
  branch are held for review and run where no dialog can show. Where a dialog can show and the
  `guardMode` option is `dialog`, the guard asks the user, and only "Run it" lets the call
  continue. With `guardMode` set to `deny`, no dialog shows. The default branch is the one
  `origin/HEAD` names, or `main` and `master` when it names none, read from local refs.
  `OMCA_DISABLED_HOOKS=bash-guard` turns the review off and never the outright deny.

  The patterns match at any command position: string start, after a separator, or inside a
  subshell or command substitution, behind wrappers such as `sudo`, `env`, `command`, `timeout`
  and `xargs` and `VAR=value` prefixes. The guard also reads commands handed to another
  interpreter: `bash -c`, `sh -c`, `eval`, a heredoc fed to a shell, `pwsh -Command`, `cmd /c` and
  `Invoke-Expression` with a literal string. Anchoring on command position keeps a literal
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
