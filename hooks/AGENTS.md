# Hook Inventory

`hooks/hooks.json` is the canonical hook registry. Query it directly for counts.

## Hook events

Registered here: `SessionStart`, `UserPromptSubmit`, `UserPromptExpansion`,
`SubagentStart`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`,
`PostToolUse`, `PostToolBatch`, `PostToolUseFailure`, `Stop`, `TaskCompleted`.

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
- `permission-filter.sh` has two roles, and they are registered on different events.
  The deny of a recursive removal runs on `PreToolUse` and on `PermissionRequest`, both
  with matcher `Bash`. The auto-allow of a narrow trusted-tooling set (npm, yarn, pnpm,
  bun, jq, `uv run`/`uv sync`) runs on `PermissionRequest` only.

  The reason for the split: `PermissionRequest` fires only when a permission dialog is
  about to be shown, while `PreToolUse` fires before tool execution regardless of
  permission status (`claude-code-docs/docs/hooks.md`, PermissionRequest input). A deny
  registered only on `PermissionRequest` is therefore inert for any command that never
  produces a dialog, and under `permissions.defaultMode: "auto"` the classifier resolves
  most shell commands without one, so that is the common case. Before the `PreToolUse`
  registration existed, a real headless turn ran `rm -rf` on a canary directory with no
  denial while the same command fed to the script on stdin denied correctly. Every doc
  that described this deny as unconditional was wrong for as long as the script was
  registered on `PermissionRequest` alone.

  The auto-allow must stay off `PreToolUse` permanently. A `PreToolUse`
  `permissionDecision: "allow"` skips the permission prompt, so the auto-mode classifier
  and any interactive confirmation never run for that command; only explicit `deny` and
  `ask` rules from settings still apply. Consolidating the two events into one handler
  for tidiness would convert a six-tool convenience into a silent standing bypass of the
  user's permission posture, which is a worse hole than the inert deny it would be
  cleaning up after. `permission-filter.sh` encodes this as an early `exit 0` on
  `hook_event_name == PreToolUse`, sitting after the deny and before the first allow. It is
  the only script that needs the guard, because it is the only one whose allow is a blanket
  fast path keyed on a tool name rather than on a command the script parsed in full.

  `git-destructive-deny.sh` is registered on both events too. It is deny-only: it emits
  an allow on no path, so a command it does not recognise gets silence, never an allow.

  It branches its output on `hook_event_name`, because the two events read a
  decision from different places: `PreToolUse` from stderr plus `exit 2` or from
  `hookSpecificOutput.permissionDecision`, `PermissionRequest` from
  `hookSpecificOutput.decision.behavior` with `exit 0`. The branch is required, not a hedge.
  Exit code 2 is not honored on `PermissionRequest`: the permission flow proceeds unchanged
  and the stderr is discarded, so only the `decision` object can deny there. Do not collapse
  the branch. `git-destructive-deny.sh`'s former trailing allow for every git command it did
  not deny was deleted, because it auto-approved everything the pattern failed to recognise,
  and a deny gate's answer to an unrecognised command is silence.

  The deny matches a recursive removal at any command position:
  string start, after a separator, or inside a subshell or command substitution. Anchoring
  on command position is what keeps a literal mention out of scope, since the `rm` in
  `grep -rn "rm -rf" scripts/` follows a quote rather than a separator. That deny branch
  runs before the operator check, so a compound command carrying a recursive removal is
  denied rather than deferred, and it must not be deleted as duplicated platform behavior
  now that auto mode adjudicates the dangerous-`rm` case without a dialog.
  `git-destructive-deny.sh` matches its destructive-git set at the same command positions,
  and it no longer emits an allow for a compound command at all: a command carrying an
  operator falls through to the platform instead of being auto-approved because its head
  happened to be a git subcommand.
- A command containing a command separator, a redirect, or a
  command substitution falls through to the platform decision instead of taking the fast
  path, because per-subcommand `if:` matching means only the first subcommand is what the
  filter saw. A carriage return is matched too, as hardening for shells that terminate a
  statement on a bare CR, which bash does not. Globs, tilde, and `$VAR` expansion still
  take the fast path: none of them can introduce a second command. The operator scan is
  quote-blind, so a command whose quoted argument contains an operator loses the fast path.
  The common case is a jq filter with a pipe: `jq -r '.a | .b' f.json` now gets the normal
  platform permission prompt. That friction is deliberate. Teaching the scan to skip quoted
  regions is how a guardrail becomes a hole, because a genuinely compound command could then
  hide its separator inside quotes. `tests/bats/hooks/permission_handlers.bats` pins the
  behavior so it cannot be "fixed" by accident.
- Hook lifecycle ownership stays Claude-native. OMCA supplies the mod's module and
  `type: mcp_tool` handlers whose `tool` is `omca_hook`; no `type: command` handler
  remains. Start-up pruning and the exit unbind run in the server process, not in a hook.
