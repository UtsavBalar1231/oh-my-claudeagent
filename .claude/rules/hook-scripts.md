---
globs: scripts/*.sh
description: Hook script conventions for oh-my-claudeagent plugin shell scripts
---

When editing or creating hook scripts:

- **Never use `set -euo pipefail`** — hooks must degrade gracefully on missing state files.
- **Read JSON from stdin**, parse fields with `jq`. Entry pattern: `INPUT=$(cat)`.
- **Atomic writes**: `tmp=$(mktemp) && ... && mv "$tmp" target.json` — never write directly.
- **Default to exit 0** — scripts should silently succeed when conditions don't apply.
- **Exit 2 in the turn-gate family**: among the hooks that gate the end of a turn or a task,
  `task-completed-verify.sh` (TaskCompleted) is the only one that blocks by exiting 2. The three
  Stop hooks use decision-control JSON instead (next bullet).
- **Exit 2 in the deny family**: exit 2 is one documented block shape for PreToolUse and
  PermissionRequest, not the only one. `claude-code-docs/docs/hooks.md` lists both events in
  its exit-code table (PreToolUse "Blocks the tool call", PermissionRequest "Denies the
  permission") and also documents JSON deny decisions for both: PreToolUse reads
  `hookSpecificOutput.permissionDecision: "deny"`, PermissionRequest reads
  `hookSpecificOutput.decision.behavior: "deny"`. Exit 2 is the shape three OMCA hooks use:
  `git-destructive-deny.sh`, `sed-grep-deny.sh`, and `executor-grep-deny.sh`
  (registered on PreToolUse `Grep` and PermissionRequest `Bash grep *`). Each writes its
  message to **stderr only** and exits 2, because the platform ignores stdout JSON on a
  non-zero exit. Do not convert these to Stop-style `decision` JSON and do not delete their
  exit-2 paths: each of these scripts ends in a `decision.behavior: "allow"`, so a hook that
  stops exiting 2 auto-approves the command it exists to block. Exit 2 is also the one deny
  shape that carries across both events unchanged, which is why `git-destructive-deny.sh`
  needs no per-event branch for its block even though it is registered on `PreToolUse` and
  `PermissionRequest` both. See "Bash guardrail wiring" below for that split.
- **Stop-hook blocking**: `plan-continuation-guard.sh`, `final-verification-evidence.sh`, and `drift-guard.sh` block by writing Stop decision-control JSON to stdout and exiting 0:

  ```json
  {"decision": "block", "reason": "..."}
  ```

  `reason` is required when blocking (`claude-code-docs/docs/hooks.md`, Stop decision control).
  That section presents `hookSpecificOutput.additionalContext` as the **alternative** to
  blocking, for non-error feedback that keeps the conversation going, and its `decision: block`
  example carries no `additionalContext` at all. Nothing documents the two combining, and how a
  block presents in the transcript when both are emitted is unverified. All three scripts
  therefore call the shared `block_exit()` helper in `scripts/lib/common.sh`, which emits
  `decision` and `reason` only.
- **State files**: `.omca/state/` relative to `CLAUDE_PROJECT_ROOT`, never `~/.claude/`.
- **Plugin-relative paths**: use `$(dirname "$0")/..` to reference plugin root from scripts.
- **shellcheck**: `enable=all`, SC1091/SC2154/SC2312 disabled (see `.shellcheckrc`).
- **Indentation**: tabs (per `.editorconfig`).
- **Registration**: a script not in `hooks/hooks.json` is dead code — always register new hooks.
- **Async hooks**: use `"async": true` only for observability (logging), not for context injection.
- **`if` field**: use for argument-level filtering on tool events (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, and `PermissionDenied`). Syntax: `"if": "Bash(git *)"`, a shell-glob matching against tool arguments. Reduces process spawning overhead. Do NOT use on dual-purpose hooks, dynamic-logic hooks, or security-critical hooks where a too-narrow filter could silently disable protection.

  Four semantics worth knowing before relying on one. A handler takes a single `if` rule, not a list. Matching is **per-subcommand**, so `jq . a.json && rm -rf ~/x` matches `Bash(jq *)`; that is the hole the compound-command fall-through in `permission-filter.sh` exists to close. A single-segment `dir/**` pattern is cwd-anchored, unlike a `deny`/`ask` permission rule of the same shape, which still matches at any depth. And an unparseable Bash command **fails open**, meaning the handler runs. Fail-open is the real reason `if` must never be load-bearing for enforcement: the `PermissionRequest` half of both Bash guardrails sits behind one, so the guardrail logic inside the script has to be correct on its own. Their `PreToolUse` registrations carry no `if` at all, deliberately, so the deny path is never narrowed by a filter.

### Bash guardrail wiring (`permission-filter.sh`, `git-destructive-deny.sh`)

Each of these two scripts carries two behaviors, and the two behaviors are registered on
different events on purpose. Read the split before touching either registration.

| Behavior | Event | Why that event |
|---|---|---|
| Deny a recursive removal / a destructive git subcommand | `PreToolUse` **and** `PermissionRequest`, matcher `Bash` | `PreToolUse` hooks "run before tool execution regardless of permission status" (`claude-code-docs/docs/hooks.md`, PermissionRequest input), so this is the only event that sees a command nobody is going to be asked about |
| Auto-allow the trusted-tooling set (npm, yarn, pnpm, bun, jq, `uv run`/`uv sync`), and `git-destructive-deny.sh`'s trailing allow for the git commands it did not deny | `PermissionRequest` only | An allow belongs where a prompt was actually going to happen |

The mechanism behind the first row, stated plainly because it was misread for a long time:
`PermissionRequest` fires only when a permission dialog is about to be shown
(`claude-code-docs/docs/hooks.md`: "PermissionRequest hooks run when a permission dialog is
about to be shown to the user, while PreToolUse hooks run before tool execution regardless of
permission status"). So a deny registered only on `PermissionRequest` is inert for every
command that never triggers a dialog. Under `permissions.defaultMode: "auto"` the auto-mode
classifier resolves most shell commands without a dialog, which makes "no dialog" the common
case rather than the edge case. That is not a hypothetical: a headless `claude -p` turn ran
`rm -rf` on a canary directory with both guardrails installed, no denial was produced, and the
directory was deleted, because at the time both scripts were registered on `PermissionRequest`
alone. The same command fed to `permission-filter.sh` on stdin returned a well-formed deny.
The regexes were right the whole time; the wiring was missing.

**The invariant: the trusted-tooling auto-allow must never be registered on `PreToolUse`.**
On `PreToolUse`, `permissionDecision: "allow"` "skips the permission prompt"
(`claude-code-docs/docs/hooks.md`, PreToolUse decision control), so the auto-mode classifier
and any interactive confirmation never run for that command. Only explicit `deny` and `ask`
rules from settings still evaluate. Consolidating the two events into one handler "so the
script is registered in one place" would therefore turn a narrow convenience for six known
tools into a standing bypass of the user's own permission posture for every command those
branches touch, and it would do it silently, since an allow produces no output the operator
sees. That hole is strictly worse than the inert-deny bug this split exists to fix. Both
scripts encode the invariant as an early `exit 0` guarded on `hook_event_name` placed after
the deny and before the first allow: on `PreToolUse` there are exactly two outcomes, the deny
or silence. Do not move, merge, or "simplify" that guard.

`hook_event_name` is absent when a script is driven on stdin by a test, and both scripts
default the field to `PermissionRequest` so existing stdin-driven fixtures keep their meaning.

### Testing methodology: stdin proves logic, not wiring

Driving a hook script on stdin proves exactly one thing, that its logic produces the right
decision for the payload you handed it. It says nothing about whether the platform ever hands
the script that payload. Event registration, matcher scope, and `if` narrowing are all
properties of `hooks/hooks.json` and of the platform's dispatch, and none of them is
observable from a bats fixture. The `rm -rf` incident above survived several review rounds for
exactly this reason: every earlier check piped a crafted payload into the script, watched a
correct deny come back, and concluded the guard worked.

So for any hook whose value depends on *when* it fires, and every guardrail is in that class,
a bats test is necessary and not sufficient. The registration check belongs in the live QA
harness, `scripts/qa/hook-live-probe.sh`, which drives a real headless `claude -p` turn
against the packaged plugin tree and asserts on the hook debug log. That is the only place a
claim like "this deny fires on an auto-allowed command" can be verified rather than assumed.
When adding a hook, ask which event you are relying on, then prove that event actually
reaches you.

### Comment gate (`comment-checker.sh`)

Runs on `PreToolUse Write|Edit|MultiEdit` and denies via
`permissionDecision: "deny"` + exit 0 — it does NOT use exit 2, so the exit-2
whitelist above is unchanged. `OMCA_COMMENT_GATE=off|advise|deny` selects the
enforcement level; the default `advise` computes deny decisions and records
them to `hook-info.jsonl` without blocking, so sensitivity can be reviewed
before the gate goes live.

Three tiers, by false-positive risk:

| Tier | Findings | Enforcement |
|---|---|---|
| 1 | literal AI attribution/authorship, ref-less `TODO: implement` | hard deny |
| 2 | restates, trivial-doc, filler, bare-todo, separator | deny once per content signature, then fail open |
| 3 | comment density, consecutive-run | advisory only, never denies |

Tier 2 fails open on a repeat because the checks are lexical token-overlap and
cannot always separate slop from a genuine non-obvious comment; the signature
state lives in `.omca/state/comment-gate-window.json`. Tier 3 stays advisory
because a whole-hunk ratio has no line to quote and mandated Google-style
headers can legitimately reach it.

Two carve-outs are load-bearing and CI-pinned in `misc_hooks.bats`: the
magic-number derivation shape required above every numeric constant is exempt
from the restates check, and non-source extensions exit before any check (the
`#` matcher would otherwise read Markdown headings as comments). Every deny
message names the comment categories that must survive the fix, so the model
cannot resolve a block by stripping required comments.

### Intentionally unfiltered hooks

These hooks deliberately omit the `if` field:

- **`write-guard.sh`** (PreToolUse / Write): dual-purpose — intercepts evidence writes AND warns on file overwrites. Filtering by evidence path would silently disable the overwrite warning.
- **`context-injector.sh`** (PostToolUse / Read|Write|Edit): walks directory trees at runtime to pattern-match `.omca/rules/*.md`. The matching logic is dynamic and cannot be reduced to a static `if` glob.
- **`permission-filter.sh` and `git-destructive-deny.sh` on PreToolUse / Bash**: these registrations exist only to make the deny fire on a command no dialog would have been shown for, so an `if` glob narrow enough to skip a spawn is also narrow enough to skip the command that needed denying. Their `PermissionRequest` registrations keep their `if` filters, because that half is the allow half and a missed spawn there costs a prompt, not a guardrail. See "Bash guardrail wiring" above.

### Stop-hook disjointness

Three Stop hooks are registered: `plan-continuation-guard.sh`,
`final-verification-evidence.sh`, and `drift-guard.sh`. Each blocks on a
mutually exclusive condition, so no ordering dependency between them exists
in practice. "Blocks" here means a stdout `decision: block` and exit 0, not exit 2:

- `plan-continuation-guard.sh` fires only when the session's bound plan has
  unchecked numbered checkboxes remaining.
- `final-verification-evidence.sh` fires only when the bound plan is fully
  checked but no `final_verification` evidence has been logged.
- `drift-guard.sh` fires only on a completion-claim in the assistant's own
  text (independent of plan-checkbox state entirely).

A corrupt `boulder.json` is the one condition both plan-scoped gates can see at
once, and the two answer it asymmetrically on purpose. `boulder_resolve.py`
prints `{}` for a registry that does not parse and for no registry at all, so a
parse failure reads as "this session has no plan" and turns plan-scoped
enforcement off invisibly. `plan-continuation-guard.sh` fails closed: it refuses
the stop with a repair message naming the file. `final-verification-evidence.sh`
only warns on stderr and keeps going. That keeps one corrupt file from firing two
gates, so the operator sees one actionable message rather than a pair. The escape
hatch is `OMCA_DISABLED_HOOKS=plan-continuation-guard`, which the block message
states.

The first two share the same `count_plan_checkboxes` helper (`scripts/lib/common.sh`)
to derive checked/unchecked counts, so they can never disagree about which
state a plan is in. `hooks/hooks.json` lists `plan-continuation-guard.sh`
before `final-verification-evidence.sh`: since the two are disjoint by
construction, array order has no functional effect on which one blocks; the
ordering is a documentation choice, not a priority mechanism.

### Legacy kill-switch back-compat

`OMCA_DISABLED_HOOKS` (a comma/whitespace-separated list of hook basenames,
checked via `hook_is_disabled()` in `scripts/lib/common.sh`) is the unified
kill-switch mechanism going forward. Three hooks predate it and still honor
their own single-purpose legacy flag as well: `OMCA_HOOK_DISABLE_GIT_DESTRUCTIVE_DENY`
(`git-destructive-deny.sh`), `OMCA_HOOK_DISABLE_FINAL_VERIFY`
(`final-verification-evidence.sh`), and `OMCA_HOOK_DISABLE_DRIFT_GUARD`
(`drift-guard.sh`). Either mechanism disables the hook: OR semantics, not a
replacement. New hooks should use `hook_is_disabled()` only.

### Platform hook reference (v2.1.94)

- **Hook output cap**: **10,000 characters**, per `claude-code-docs/docs/hooks.md` (the JSON-output section states it for `additionalContext`, `systemMessage`, and plain stdout, and the `additionalContext` section repeats it). Output past the cap is saved to a file in the session directory and the context injection receives a file path plus a preview instead of inline content. Known follow-up: `scripts/context-injector.sh` caps each injected item but has no aggregate cap, so a deep directory walk can emit well into five figures.
- **Additional platform events**: `Elicitation` fires when an **MCP server** requests user input (the requester is the server, not the model); `ElicitationResult` fires after the user responds. Neither is registered by OMCA.
- **`PermissionDenied` IS registered.** It fires when the auto-mode permission classifier denies a tool call, and `scripts/permission-denied-coach.sh` handles it. The classifier defaults to Sonnet 5, is validated on the session's first auto-mode request, and is then pinned for the session, so its verdicts are stable within a session but not across model changes. A classifier model configured server-side takes precedence over that default, and a session on Sonnet 4.6, a session whose `availableModels` excludes Sonnet 5, or a session on Fable 5 falls back to the session model or to an Opus model (`claude-code-docs/docs/permission-modes.md`). `permission-denied-coach.sh` returns `retry: true` inside `hookSpecificOutput`, alongside `hookEventName` and `additionalContext`. That is the only location the platform reads for this event; a top-level `retry` key is silently ignored, so the model receives the bare rejection with no retry signal. Exit code and stderr are also ignored on PermissionDenied because the denial has already happened, which makes the JSON body the hook's only channel. The retry signal does not reverse the denial either: it tells the model a retry is permitted. Only a `type: command` hook can set `retry` at all, so PermissionDenied coaching cannot move to a `type: prompt` or `type: agent` handler. Do not narrow this handler with an `if` filter: a denial can arrive for any tool.
- **`defer` permission decision**: PreToolUse hooks can return `permissionDecision: "defer"` in non-interactive `-p` mode. Pauses the session so an SDK wrapper can collect input and resume with `--resume`. Only relevant for Agent SDK integration.
- **Handler types**: OMCA uses `type: command` exclusively. The platform also supports `type: prompt` (LLM-evaluated), `type: agent` (agentic verifier with tool access), and `type: http` (HTTP POST to endpoint).
- **`suppressOutput` field**: Set `"suppressOutput": true` on a hook to omit stdout from debug logs. Useful for noisy async hooks.
- **`timeout` field**: **Seconds, not milliseconds.** `"timeout": 5` is a five-second cap; `"timeout": 5000` is an 83-minute cap, which loosens the default rather than tightening it. Per-event defaults:

| Handler type / event | Default timeout (s) |
|---|---|
| `command`, `http`, `mcp_tool` | 600 |
| `prompt` | 30 |
| `agent` | 60 |
| `UserPromptSubmit` (`command`/`http`/`mcp_tool`) | 30 |
| `MessageDisplay` | 10 |
| `SessionEnd` | 1.5 |

  `hooks.json` cannot carry comments, so the derivation for the `timeout` values it declares
  lives here. **`timeout: 5` on the `boulder_resolve.py` shim callers and the blocking
  handlers.** Derived from `.omca/logs/hook-timing.jsonl`: the slowest handler in this class is
  `subagent-start.sh` at a p99 of 197ms (max 199ms), with `context-injector.sh` at a p99 of
  29ms (max 179ms) and `comment-checker.sh` at a p99 of 13ms (max 29ms). The four shim callers
  log no timing rows, so they were measured directly, fastest of five runs each:
  `plan-continuation-guard.sh` 27ms, `final-verification-evidence.sh` 26ms, `session-init.sh`
  53ms, `pre-compact.sh` 118ms. 5s is roughly 25x the worst measured p99 and matches the caps
  already on `SubagentStop` and `SessionEnd`. Re-derive before changing the number rather than
  raising it to make a slow handler pass.

  Two blocking handlers carry no `timeout`, and the omission is deliberate. A cap that trips on a
  gate does not fail the gate loudly: the handler is cancelled, the block never reaches the
  platform, and the transition it was guarding proceeds. So a cap is only safe where the work is
  bounded and measured. `drift-guard.sh` is neither, because it walks
  `git ls-files --others` and scans each result, so its cost scales with the repo's
  untracked-file count rather than with anything this table can predict. `task-completed-verify.sh`
  is cheap enough to cap but has no timing rows yet; measure it before adding one, rather than
  copying the 5s from a handler with a different cost profile.

  The `SessionEnd` row is documentation only. The platform raises the session-exit budget to the highest per-hook `timeout` found in *settings files*; a timeout declared in a plugin-provided `hooks.json` never raises it. So `session-cleanup.sh` still gets killed at 1.5s, and its `timeout` value cannot fix the session-binding leak that kill causes. The only lever is the user-side `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` env var (milliseconds); recovery otherwise falls to the `SessionStart` boulder GC layer.

### Shell form and quoting

OMCA hook handlers use shell form: `command` holds the script path and `args` is absent. The
path placeholder must be quoted, because shell form passes the string to a shell that
word-splits on the space in a marketplace cache path:

```json
{
  "type": "command",
  "command": "\"${CLAUDE_PLUGIN_ROOT}/scripts/postedit-format-and-lint.sh\""
}
```

Exec form (`args` present) is off limits for these handlers. Exec form resolves `command` as a
real executable with no shell, and a `.sh` file is not an executable on native Windows, so
every exec-form hook would silently fail to spawn there: no session context, no permission
guardrails, no Stop gates, and no error signal. Shell form routes through Git Bash on Windows
and honors the shebang. Exec form also makes the platform ignore the `shell` field, discarding
the Git Bash and PowerShell selection.

Reach for exec form only when `command` is a real cross-platform binary and the script is an
argument, such as `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/x.js"]`, or when
a plugin hook needs `${user_config.*}` substitution, which shell form rejects.

The quotes are shell syntax, not part of the filename, so `scripts/validate-plugin.sh` has to
strip them before resolving a handler path; without that, every quoted command reads as a
missing script.

### `statusMessage` field

`statusMessage` is a common hook field (a sibling of `type`, `timeout`, and `if`) holding the spinner label shown while that handler runs.

Apply it selectively. Most OMCA handlers finish in milliseconds, so a label for them flashes and reads as noise. Add one only when a user actually waits on the handler:

| Handler | Why the wait is felt |
|---|---|
| `session-init.sh` | Runs before the first turn, walks state files and resolves the bound plan |
| `context-injector.sh` | Walks directory trees per Read/Write/Edit to match rule files |
| `comment-checker.sh` | Gates every Write/Edit and can deny, so the user is blocked on its verdict |
| `*-error-recovery.sh` | Fires on a failure the user is already watching |

New handlers get no `statusMessage` unless they land in that category.

### `continueOnBlock`

No longer provisional. It is a handler-config field on `type: prompt` and `type: agent` handlers, and it changes what an `ok: false` verdict does: `"continueOnBlock": true` feeds the handler's rejection reason back to Claude so the turn continues instead of ending. Its per-event table covers `PostToolUse` along with `PreToolUse` and `TeammateIdle`, so "PostToolUse field" was only ever half wrong: the event is in scope, the handler types are not. OMCA registers `type: command` handlers exclusively, so the field is unreachable from here and the old "future hooks declare `continueOnBlock: true`" advice was never actionable. Delete that expectation rather than carry it.

### `${user_config.*}` is rejected in shell-form hooks

A plugin hook cannot interpolate `${user_config.<key>}` into a shell-form `command`. Plugin option values reach a handler two other ways: the `$CLAUDE_PLUGIN_OPTION_<KEY>` environment variable, or an exec-form `args` element. Every OMCA handler is shell form, and shell form is mandatory for `.sh` handlers (see "Shell form and quoting"), so the environment variable is the path here: read `$CLAUDE_PLUGIN_OPTION_<KEY>` inside the script, where `<KEY>` is the option key uppercased. Switching a handler to exec form to reach an option value trades a Windows-working hook for a Windows-dead one.

### Exit-2 and infrastructure-error guarantees (v2.1.212, v2.1.214)

Two reliability facts worth writing down because a convention depends on them:

- An exit-2 block lands even when the hook's stdout JSON fails schema validation. An audit of every OMCA exit-2 path came back clean: all of them write to stderr only, and none emits stdout JSON. That stderr-only convention is load-bearing for those hooks, not stylistic. (The Stop hooks are the other case: they exit 0 and their stdout JSON is the block.) A hook that emits malformed JSON alongside its exit 2 still blocks, but a reader who assumes otherwise will add a JSON payload and be surprised when it is ignored.
- A hook infrastructure error is not presented as a user rejection, and `continue: false` no longer drops a halt. OMCA emits `continue: false` nowhere, so only the first half applies, and it holds reliably from v2.1.212 on.

### `asyncRewake` is not adopted

The obvious candidate for it, `post-edit.sh`, only logs and always exits 0, and the format-and-lint hook is synchronous and project-local. Adopting `asyncRewake` would need carve-outs in two load-bearing rules here for no behavioral gain.

### Preferred helpers (from `scripts/lib/common.sh`)

Hooks must source `scripts/lib/common.sh` and use these helpers rather than
reinvent the idioms inline. Each lands only if it replaces ≥3 existing callsites
(enforced during review).

| Helper | Purpose | Usage example |
|---|---|---|
| `log_hook_error <msg> [hook_name]` | Structured stderr write to `hook-errors.jsonl` | `log_hook_error "marker read failed" "$(basename "$0")"` |
| `log_hook_info <msg> [hook_name]` | Structured info write to `hook-info.jsonl` (schema: timestamp, level, hook, message) | `log_hook_info "plan loaded" "$(basename "$0")"` |
| `section_header <title>` | Runtime output formatting for additionalContext | `echo "$(section_header 'Recent edits')"` |
| `jq_read <file> <jq-expr> [default]` | Single-idiom JSON field read | `active=$(jq_read "$BOULDER" '.active_plan' "")` |
| `emit_context <event_name> <message>` | Emit `hookSpecificOutput` JSON | `emit_context "SessionStart" "$ADDITIONAL_CONTEXT"` |
| `hook_timing_log <start_ns>` | Append timing entry | `hook_timing_log "$_HOOK_START"` |
| `resolve_session_id` | Three-tier current-session lookup | `sid=$(resolve_session_id)` |
| `mode_is_active <mode>` | Is mode's state file `active`? | `mode_is_active ralph && echo active` |
| `block_exit <reason>` | Block a Stop with a reason: stdout-only `decision`+`reason`, exit 0, static fallback payload if `jq` fails | `block_exit "Plan has unchecked tasks."` |

### Defensive slop — anti-patterns

**DON'T**:
```bash
VAL=$(jq -r '.x // ""' "$F" 2>/dev/null || echo "")
```
Both guards are dead: jq's `//` handles missing/null; `|| echo ""` is belt-and-suspenders.

**DO**:
```bash
VAL=$(jq_read "$F" '.x' "")
```
Or, when the helper isn't reached yet:
```bash
VAL=$(jq -r '.x // ""' "$F")
```

**DON'T**:
```bash
COUNT=$(jq -r '.count // 0' "$F" 2>/dev/null || echo "0")
COUNT="${COUNT:-0}"
```
Triple-guarded. Pick ONE default; the `${VAR:-0}` outer default handles both empty-from-jq-error and empty-from-missing-field.

**DO**:
```bash
COUNT=$(jq -r '.count // 0' "$F")
COUNT="${COUNT:-0}"
```
Or use `jq_read`.

**DON'T** for `grep -c`:
```bash
N=$(grep -c PATTERN file || echo 0)
```
`grep -c` prints `0` AND exits 1 on no-match → `|| echo 0` produces `"0\n0"` which breaks arithmetic.

**DO**:
```bash
N=$(grep -c PATTERN file || true)
```

### Function naming

- Functions prefixed `check_*`, `validate_*`, `verify_*` MUST be side-effect-free.
- Functions that exit the script or mutate globals MUST use an explicit action verb in the name: `allow_`, `clear_`, `maybe_exit_`, `sweep_`, etc.
- **No `_` prefix on helper function names.** The historical convention (Google Shell Style Guide "private helper") adds visual noise with no benefit in this single-library codebase. All `common.sh` helpers and script-local helpers use plain names (e.g. `log_hook_error`, not `_log_hook_error`).

### Magic numbers

Every numeric constant assignment gets a single-line derivation comment within 2 lines above:

```bash
# 3600s (1h) — F1-F4 evidence freshness window. Sibling uses 300s; UNDOCUMENTED divergence.
MAX_EVIDENCE_AGE_SECONDS=3600
```

Target: ≤90 characters. If rationale doesn't fit, use a pointer:

```bash
# 300s — task-completed-verify freshness. See .omca/notes/refactor-hook-corpus-constants.md.
MAX_EVIDENCE_AGE_SECONDS=300
```

If rationale is undiscoverable from code/git-blame, write `UNDOCUMENTED` in the comment — do NOT guess.

### Plan-reference comments — forbidden

Do NOT cite plan task numbers, plan basenames, or "Task N of <plan>" in comments.
After a plan merges, those references become archaeology — they point at nothing
a future reader can find.

**Write the invariant, not the history.**

- **Wrong**: `# Session-aware staleness short-circuits (Task 3 of fix-orphan-pending-final-verify-marker).`
- **Right**: `# Session-aware staleness short-circuits: clear the marker when independent signals prove it stale.`

### Logging paths

| Intent | Channel |
|---|---|
| User-facing blocking message from a non-Stop hook (paired with non-zero exit) | `echo "..." >&2` + `exit 2` |
| User-facing blocking message from a Stop hook | Stop decision-control JSON on **stdout** + `exit 0`. The copy travels in `reason`, not stderr. Kill-switch and stdin-timeout banners in those same scripts still use `>&2` |
| User-visible informational banner (kill-switch, mode transition) | `echo "..." >&2` |
| Internal audit for later inspection | `log_hook_error "..." "$(basename "$0")"` (writes to `.omca/logs/hook-errors.jsonl`) |
| Developer debug (wrapped in `OMCA_DEBUG` conditional) | `log_hook_error "..." "$(basename "$0")"` with a `[DEBUG]` prefix |

No hook currently registered on `SessionStart` or `SubagentStart` exits 2, but a future one that does must treat its stderr as user-facing copy: the platform surfaces it.

**Ambiguity rule**: When a message could be either user-visible-info or internal-audit, KEEP `>&2`. Moving a currently-visible message off stderr is a silent UX regression. Ambiguity always resolves toward user-visibility.
