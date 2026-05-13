# Design Note: Stale `.in_use/` PID Marker Garbage Collector

**Status**: Design only — implementation in T12, tests in T13.
**Date**: 2026-05-13

---

## 1. Marker Semantics

### Who writes

The `.in_use/` directory and its marker files are written by **Claude Code's native plugin
runtime**, not by any OMCA script. When Claude Code activates a plugin for a session it
creates a zero-or-small-JSON file inside the plugin's cache install directory:

```
${CLAUDE_PLUGIN_ROOT}/.in_use/<pid>
```

Each file is named after the OS PID of the Claude Code process that activated the plugin.
The file body is a small JSON object:

```json
{"pid":191499,"procStart":"396011"}
```

- `pid` — the OS process ID (integer), mirrored as the filename.
- `procStart` — the process-start epoch-time or ticks string, useful for distinguishing PID
  reuse (same PID recycled to a different process after the original exits).

### Who reads

No existing OMCA script reads `.in_use/` markers today. The `concurrency_status` MCP tool
(`servers/tools/catalog.py`) tracks in-session agent concurrency via `active-agents.json`
in `.omca/state/` — an entirely separate mechanism. The `.in_use/` directory is a
**platform-level** plugin-activation lock; OMCA is responsible only for GC at session-init.

### Lifecycle

- **Created**: by Claude Code when a session loads the plugin (before any hook fires).
- **Removed** (normal): by Claude Code when the session that created it ends cleanly.
- **Stranded**: when a session crashes, is killed with SIGKILL, or the machine is rebooted
  without a clean session end. The platform does not GC orphaned markers on its own.

Observed sample (14 markers on 2026-05-13; PIDs cross-checked against running processes):
PIDs `11490`, `70439`, `70957`, `149851`, `191499`, `196266`, `196969`, `200886`,
`216355`, `302431`, `304724`, `313572`, `320714`, `3929559` — the majority are stale.

---

## 2. Path Discovery

The `.in_use/` directory lives **inside the plugin's runtime install path**, which Claude
Code exposes to hook scripts via the environment variable `CLAUDE_PLUGIN_ROOT`. This is
the same variable session-init.sh already relies on (line 11):

```sh
PLUGIN_ROOT_SYNC="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
```

The GC script MUST derive the path the same way:

```sh
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
IN_USE_DIR="${PLUGIN_ROOT}/.in_use"
```

**Do NOT hardcode the version number** (`2.0.0`). The path is version-agnostic at runtime
because `CLAUDE_PLUGIN_ROOT` already resolves to the exact versioned cache directory for
the running install.

---

## 3. Cross-Platform Liveness Check

For each marker file `${IN_USE_DIR}/<pid>`:

1. **Parse PID** from the filename (the filename IS the PID string).
2. **Optional: parse `procStart`** from file content to guard against PID reuse. If the
   current process with that PID has a different start-time, the marker is orphaned even
   if the PID is numerically alive.
3. **Liveness check** (platform-branched):

```sh
case "$(uname -s)" in
  Linux)
    # /proc/<pid> is the canonical, zero-overhead check on Linux.
    if [ -d "/proc/${pid}" ]; then
      alive=1
    fi
    ;;
  Darwin)
    # kill -0 sends no signal; exit 0 iff process exists and is visible.
    if kill -0 "${pid}" 2>/dev/null; then
      alive=1
    fi
    ;;
  *)
    # TODO(windows-liveness): use tasklist or PowerShell Get-Process
    # Windows: skip liveness check, leave marker in place.
    alive=1
    ;;
esac
```

The greppable marker `# TODO(windows-liveness): use tasklist or PowerShell Get-Process`
must appear verbatim in the implementation so future maintainers can locate the deferral
with `rg "TODO\(windows-liveness\)"`.

**Note on PID reuse**: if `procStart` is present in the marker JSON and `/proc/<pid>/stat`
(Linux) can be read, compare field 22 (start time in clock ticks) against the stored
`procStart`. Mismatch → treat as dead. This check is **optional** (belt-and-suspenders);
the primary liveness check is sufficient for the common case.

---

## 4. Integration Point

### Where to add the GC call

Add a new dedicated script: **`scripts/gc-in-use-markers.sh`**. Do not inline the GC
logic into `session-init.sh` — it is already responsible for state resets, migration, and
context output. A separate script keeps both files auditable and allows independent
testing (T13).

Chain it from the **SessionStart** hook in `hooks/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/gc-in-use-markers.sh" }
        ]
      },
      {
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/session-init.sh" }
        ]
      },
      ...
    ]
  }
}
```

Place the GC entry **before** `session-init.sh` so any marker-count logging from the GC
appears before the session-init context output.

Alternatively (simpler, no hooks.json change), `session-init.sh` can source or exec
`gc-in-use-markers.sh` in its preamble — this keeps the hook list tidy and avoids a
hooks.json schema change. Either approach is valid; the separate-script form is preferred
for testability.

---

## 5. Failure Tolerance

**A GC error MUST NOT block or fail session-init.**

The GC script must:

- Set no `errexit` (`set -e` is dangerous here), or catch every error explicitly.
- Wrap the entire GC body in a subshell: `( ... ) || true`.
- Exit 0 unconditionally — any non-zero exit would propagate to Claude Code as a hook
  failure, blocking the session start.
- Log errors to `${HOOK_LOG_DIR}/hook-errors.jsonl` via `log_hook_error` (from
  `scripts/lib/common.sh`) rather than stderr, consistent with other OMCA hook scripts.

Pattern:

```sh
#!/bin/bash
source "$(dirname "$0")/lib/common.sh"

(
  # ... GC logic ...
) || log_hook_error "gc-in-use-markers: GC failed (non-fatal)" "gc-in-use-markers.sh"

exit 0
```

---

## 6. Age-Based Eviction Sub-Decision

**Decision: NO age-based eviction.**

Rationale: PID liveness is the correct and sufficient signal. Age-based eviction (e.g.
"remove markers older than 7 days") risks deleting markers from long-lived sessions where
the user has kept the same Claude Code instance running across multiple days. The PID
liveness check handles all cases:

- Normal exit: platform removes marker.
- Crash/kill: PID no longer exists → GC removes marker at next session-init.
- Long-lived session: PID is alive → marker is kept correctly.

This decision is final for T12. Do not implement an age-based fallback unless a concrete
failure case is reported.

---

## 7. Summary

| Concern | Decision |
|---|---|
| Writer | Claude Code native plugin runtime (not OMCA) |
| Marker filename | OS PID of the Claude process that activated the plugin |
| Marker content | `{"pid": N, "procStart": "S"}` JSON |
| Path derivation | `${CLAUDE_PLUGIN_ROOT}/.in_use/` — never hardcode version |
| GC trigger | SessionStart hook, before `session-init.sh` |
| GC script | New `scripts/gc-in-use-markers.sh` |
| Linux liveness | `[ -d /proc/<pid> ]` |
| macOS liveness | `kill -0 <pid> 2>/dev/null` |
| Windows | `# TODO(windows-liveness): use tasklist or PowerShell Get-Process` — skip |
| Failure mode | `exit 0` always; errors go to hook-errors.jsonl |
| Age-based eviction | NO |
