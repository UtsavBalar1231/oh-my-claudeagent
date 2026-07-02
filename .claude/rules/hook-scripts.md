---
globs: scripts/*.sh
description: Hook script conventions for oh-my-claudeagent plugin shell scripts
---

When editing or creating hook scripts:

- **Never use `set -euo pipefail`** — hooks must degrade gracefully on missing state files.
- **Read JSON from stdin**, parse fields with `jq`. Entry pattern: `INPUT=$(cat)`.
- **Atomic writes**: `tmp=$(mktemp) && ... && mv "$tmp" target.json` — never write directly.
- **Default to exit 0** — scripts should silently succeed when conditions don't apply.
- **Exit 2**: only for `task-completed-verify.sh`, `final-verification-evidence.sh`, `drift-guard.sh`, and `plan-continuation-guard.sh` to block transitions.
- **State files**: `.omca/state/` relative to `CLAUDE_PROJECT_ROOT`, never `~/.claude/`.
- **Plugin-relative paths**: use `$(dirname "$0")/..` to reference plugin root from scripts.
- **shellcheck**: `enable=all`, SC1091/SC2154/SC2312 disabled (see `.shellcheckrc`).
- **Indentation**: tabs (per `.editorconfig`).
- **Registration**: a script not in `hooks/hooks.json` is dead code — always register new hooks.
- **Async hooks**: use `"async": true` only for observability (logging), not for context injection.
- **`if` field**: use for argument-level filtering on tool events (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`). Syntax: `"if": "Bash(git *)"` — shell-glob matching against tool arguments. Reduces process spawning overhead. Do NOT use on dual-purpose hooks, dynamic-logic hooks, or security-critical hooks where a too-narrow filter could silently disable protection.

### Intentionally unfiltered hooks

Two hooks deliberately omit the `if` field:

- **`write-guard.sh`** (PreToolUse / Write): dual-purpose — intercepts evidence writes AND warns on file overwrites. Filtering by evidence path would silently disable the overwrite warning.
- **`context-injector.sh`** (PostToolUse / Read|Write|Edit): walks directory trees at runtime to pattern-match `.omca/rules/*.md`. The matching logic is dynamic and cannot be reduced to a static `if` glob.

### Stop-hook disjointness

Three Stop hooks are registered: `plan-continuation-guard.sh`,
`final-verification-evidence.sh`, and `drift-guard.sh`. Each blocks on a
mutually exclusive condition, so no ordering dependency between them exists
in practice:

- `plan-continuation-guard.sh` fires only when the session's bound plan has
  unchecked numbered checkboxes remaining.
- `final-verification-evidence.sh` fires only when the bound plan is fully
  checked but no `final_verification` evidence has been logged.
- `drift-guard.sh` fires only on a completion-claim in the assistant's own
  text (independent of plan-checkbox state entirely).

The first two share the same `count_plan_checkboxes` helper (`scripts/lib/common.sh`)
to derive checked/unchecked counts, so they can never disagree about which
state a plan is in. `hooks/hooks.json` lists `plan-continuation-guard.sh`
before `final-verification-evidence.sh`: since the two are disjoint by
construction, array order has no functional effect on which one blocks — the
ordering is a documentation choice, not a priority mechanism.

### Legacy kill-switch back-compat

`OMCA_DISABLED_HOOKS` (a comma/whitespace-separated list of hook basenames,
checked via `hook_is_disabled()` in `scripts/lib/common.sh`) is the unified
kill-switch mechanism going forward. Three hooks predate it and still honor
their own single-purpose legacy flag as well: `OMCA_HOOK_DISABLE_GIT_DESTRUCTIVE_DENY`
(`git-destructive-deny.sh`), `OMCA_HOOK_DISABLE_FINAL_VERIFY`
(`final-verification-evidence.sh`), and `OMCA_HOOK_DISABLE_DRIFT_GUARD`
(`drift-guard.sh`). Either mechanism disables the hook — OR semantics, not a
replacement. New hooks should use `hook_is_disabled()` only.

### Platform hook reference (v2.1.94)

- **Hook output cap**: Hook output exceeding 50,000 characters is saved to disk by Claude Code. The context injection receives a file path + preview instead of inline content. Keep OMCA hook output well under this limit.
- **Additional platform events**: `Elicitation` (MCP server requests user input), `ElicitationResult` (after user responds), `PermissionDenied` (auto-mode classifier denies a tool call — return `{retry: true}` in hookSpecificOutput to allow retry). Not currently used by OMCA.
- **`defer` permission decision**: PreToolUse hooks can return `permissionDecision: "defer"` in non-interactive `-p` mode. Pauses the session so an SDK wrapper can collect input and resume with `--resume`. Only relevant for Agent SDK integration.
- **Handler types**: OMCA uses `type: command` exclusively. The platform also supports `type: prompt` (LLM-evaluated), `type: agent` (agentic verifier with tool access), and `type: http` (HTTP POST to endpoint).
- **`suppressOutput` field**: Set `"suppressOutput": true` on a hook to omit stdout from debug logs. Useful for noisy async hooks.
- **`timeout` field**: Override the default 600s timeout for command hooks (ms). Example: `"timeout": 30000` for a 30-second cap.

### `args:` exec form (v2.1.139+)

When `args` is present, Claude Code resolves `command` as an executable on `PATH` and spawns it directly with `args` as the argument vector — no shell. Path placeholders like `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` are substituted as plain strings inside `command` and each `args` element. Special characters (`$`, backticks, apostrophes) pass through verbatim.

```json
{
  "type": "command",
  "command": "${CLAUDE_PLUGIN_ROOT}/scripts/postedit-format-and-lint.sh",
  "args": []
}
```

Adopted by `.claude/settings.json` PostToolUse Write|Edit. Other OMCA hooks already use bare-script invocation with no shell metacharacters, so migration is on demand rather than mandated.

### `continueOnBlock` (v2.1.139+) — PROVISIONAL

PostToolUse hooks can set `"continueOnBlock": true` to feed the hook's rejection reason back to Claude as a continuation prompt rather than hard-stopping the turn. Useful for soft-block hooks (nudge-style critique) where the model should adjust and proceed instead of abort. When `false` (default), a `decision: "block"` ends the turn.

OMCA does not use this field — all OMCA PostToolUse hooks are observability or context-injection (no `decision: "block"` returns). Future hooks that want nudge semantics declare `continueOnBlock: true` explicitly.

PROVISIONAL: at plan-write time the field appeared only in the v2.1.139 release notes, not in the live `https://code.claude.com/docs/en/hooks` page. The release notes are authoritative; live docs may lag. Re-verify field name and default before relying on it in a new hook.

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
| User-facing blocking message (paired with non-zero exit) | `echo "..." >&2` + `exit 2` |
| User-visible informational banner (kill-switch, mode transition) | `echo "..." >&2` |
| Internal audit for later inspection | `log_hook_error "..." "$(basename "$0")"` (writes to `.omca/logs/hook-errors.jsonl`) |
| Developer debug (wrapped in `OMCA_DEBUG` conditional) | `log_hook_error "..." "$(basename "$0")"` with a `[DEBUG]` prefix |

**Ambiguity rule**: When a message could be either user-visible-info or internal-audit, KEEP `>&2`. Moving a currently-visible message off stderr is a silent UX regression. Ambiguity always resolves toward user-visibility.
