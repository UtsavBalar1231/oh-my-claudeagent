# Hook Inventory

`hooks/hooks.json` is the canonical hook registry. Query it directly for counts.

## Hook events

Registered here: `SessionStart`, `UserPromptSubmit`, `UserPromptExpansion`,
`SubagentStart`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`,
`PostToolUse`, `PostToolUseFailure`, `Stop`, `TaskCompleted`.

Regenerate that list with `jq -r '.hooks | keys[]' hooks/hooks.json`. Every other platform
event is unregistered on purpose; `OMCA.md` carries the per-event reason.

## Current runtime contract

- `UserPromptSubmit` and `UserPromptExpansion` route to the server's `keyword-detector` and
  `slash-mode-detector` handlers, and both to its `guidance` handler, which injects the
  guidance template, the session id and the bound plan's context on a session's first prompt.
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
  restore, recursive `git rm`, path checkout), any other recursive removal, and a force push are
  held for review. Where a dialog can show and the `guardMode` option is `dialog`, the guard asks
  the user and only "Run it" lets the call continue. Otherwise the git family that discards work
  is denied and a recursive removal of a deeper path or a force push runs.
  `OMCA_DISABLED_HOOKS=bash-guard` turns the review off and never the outright deny.

  The patterns match at any command position: string start, after a separator, or inside a
  subshell or command substitution, behind `sudo`, `env`, `command` and `VAR=value` prefixes.
  Anchoring on command position keeps a literal mention out of scope, since the `rm` in
  `grep -rn "rm -rf" scripts/` follows a quote rather than a separator. `tool.check` runs
  before every Bash call in every permission mode, so the guard never depends on a dialog being
  shown. A deny registered only on `PermissionRequest` would be inert for any command that never
  produces a dialog, which under `permissions.defaultMode: "auto"` is the common case. Auto mode
  also adjudicates the dangerous-`rm` case without a dialog, but the guard is not backed by that
  and must not be deleted as duplicated platform behavior.
- `tool.check` never returns an allow, because an allow there skips the auto-mode classifier.
  The auto-allow of a narrow trusted-tooling set lives in the server's `PermissionRequest`
  handler (`servers/hooks/trusted-tooling.ts`, with its rules in
  `src/core/trusted-tooling.ts`): the `run`, `test`, `ci`, `list` and `view` subcommands of npm,
  yarn, pnpm and bun, `jq` without `--rawfile`, and `uv run` and `uv sync`. `PermissionRequest`
  fires only when a permission dialog is about to be shown, so that handler can only remove a
  prompt the user would otherwise see. It must stay off `PreToolUse`: a `PreToolUse`
  `permissionDecision: "allow"` skips the permission prompt, so the auto-mode classifier and any
  interactive confirmation never run for that command, and only explicit `deny` and `ask` rules
  from settings still apply. Moving it there would convert a six-tool convenience into a silent
  standing bypass of the user's permission posture.
- A command containing a command separator, a redirect, or a command substitution falls through
  to the platform decision instead of taking the fast path, because per-subcommand `if:`
  matching means only the first subcommand is what the handler saw. A carriage return is matched
  too, as hardening for shells that terminate a statement on a bare CR, which bash does not.
  Globs, tilde, and `$VAR` expansion take the fast path: none of them can introduce a second
  command. The operator scan is quote-blind, so a command whose quoted argument contains an
  operator loses the fast path. The common case is a jq filter with a pipe:
  `jq -r '.a | .b' f.json` gets the normal platform permission prompt. That friction is
  deliberate. Teaching the scan to skip quoted regions is how a guardrail becomes a hole,
  because a genuinely compound command could then hide its separator inside quotes.
  `src/core/trusted-tooling.spec.ts` pins the behavior so it cannot be "fixed" by accident.
- Hook lifecycle ownership is Claude-native. OMCA supplies the mod's module and
  `type: mcp_tool` handlers whose `tool` is `omca_hook`, and every registered handler is of that
  type. Start-up pruning and the exit unbind run in the server process, not in a hook.
