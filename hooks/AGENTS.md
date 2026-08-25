# Hook Inventory

`hooks/hooks.json` is the canonical hook registry. Query it directly for counts.

## Hook events

Registered here: `SessionStart`, `UserPromptSubmit`, `UserPromptExpansion`,
`SubagentStart`, `SubagentStop`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`,
`PostToolUse`, `PostToolUseFailure`, `Stop`, `TaskCompleted`, `PreCompact`, `SessionEnd`.

Regenerate that list with `jq -r '.hooks | keys[]' hooks/hooks.json`. Every other platform
event is unregistered on purpose; `OMCA.md` carries the per-event reason.

## Current runtime contract

- `UserPromptSubmit` routes to `keyword-detector.sh` for activation keywords.
- `UserPromptExpansion` routes to `slash-command-mode-detector.sh`.
- `PermissionDenied` routes to `permission-denied-coach.sh`, which turns an auto-mode
  classifier denial into retry guidance.
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

  `git-destructive-deny.sh`, `sed-grep-deny.sh`, and `executor-grep-deny.sh` are registered
  on both events too. `git-destructive-deny.sh` and `executor-grep-deny.sh` are deny-only:
  neither emits an allow on any path. `sed-grep-deny.sh` is the one exception, and a narrow
  one. When it recognises a plain `grep` invocation it can translate, it allows the call
  with an `updatedInput` rewrite to `rg` instead of denying and costing a round trip. The
  property that matters is unchanged: a command it does not recognise still gets silence,
  never an allow. `executor-grep-deny.sh` deliberately has no such rewrite, because the
  policy it carries is that the executor queries code through `ast_search`; `rg` is still
  text grep, so rewriting there would reverse the policy rather than restate the command.

  Each of the three branches its output on `hook_event_name`, because the two events read a
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
- Hook lifecycle ownership stays Claude-native. OMCA supplies the handlers: `type: command`
  for every shell handler, plus one `type: mcp_tool` handler whose `tool` is
  `validate_plan_write`. Query `hooks/hooks.json` for the current handler types rather than
  assuming a single kind.
