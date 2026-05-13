# Cold-Start Ordering Audit — omca-mcp.py

**Date**: 2026-05-13
**Auditor**: executor (Task 8 — design-only, no code changes)
**Source audited**: `servers/omca-mcp.py` + all modules under `servers/tools/`

---

## 1. Current Ordering Inventory

Numbered in execution order from process exec to first MCP `initialize` reply:

| # | Action | File / Line | Position | I/O? |
|---|--------|-------------|----------|------|
| 1 | `import signal, sys` | `omca-mcp.py:9-10` | **BEFORE `mcp.run()`** | No |
| 2 | `from mcp.server.fastmcp import FastMCP` | `omca-mcp.py:12` | **BEFORE `mcp.run()`** | No — pure stdlib/package import |
| 3 | `from tools import ast as ast_tools, boulder, catalog, evidence, filesystem, notepad, validate_plan_write` | `omca-mcp.py:14-22` | **BEFORE `mcp.run()`** | No — module-level code in all tool files is pure constant/class definitions; no I/O at import time (see §1a below) |
| 4 | `mcp = FastMCP("omca")` | `omca-mcp.py:24` | **BEFORE `mcp.run()`** | No — in-memory object construction |
| 5 | `ast_tools.register(mcp)` | `omca-mcp.py:26` | **BEFORE `mcp.run()`** | No — registers tool closures in FastMCP's internal registry; `_SG_BIN` is `None` at this point |
| 6 | `boulder.register(mcp)` | `omca-mcp.py:27` | **BEFORE `mcp.run()`** | No — pure closure registration |
| 7 | `evidence.register(mcp)` | `omca-mcp.py:28` | **BEFORE `mcp.run()`** | No — pure closure registration |
| 8 | `filesystem.register(mcp)` | `omca-mcp.py:29` | **BEFORE `mcp.run()`** | No — pure closure registration |
| 9 | `notepad.register(mcp)` | `omca-mcp.py:30` | **BEFORE `mcp.run()`** | No — pure closure registration |
| 10 | `catalog.register(mcp)` | `omca-mcp.py:31` | **BEFORE `mcp.run()`** | No — pure closure registration; imports `discover_binary`/`get_sg_bin` symbols but does not call them |
| 11 | `validate_plan_write.register(mcp)` | `omca-mcp.py:32` | **BEFORE `mcp.run()`** | No — pure closure registration |
| 12 | `signal.signal(SIGINT, SIG_IGN)` | `omca-mcp.py:35` | **BEFORE `mcp.run()`** | No — syscall, near-zero latency |
| 13 | `def _graceful_exit(...)` | `omca-mcp.py:38-39` | **BEFORE `mcp.run()`** | No — function definition |
| 14 | `signal.signal(SIGTERM, _graceful_exit)` | `omca-mcp.py:42` | **BEFORE `mcp.run()`** | No — syscall, near-zero latency |
| 15 | `sg_bin = ast_tools.discover_binary()` | `omca-mcp.py:45` | **BEFORE `mcp.run()` — inside `if __name__ == "__main__":`** | **YES — filesystem + subprocess** |
| 16 | `ast_tools.set_sg_bin(sg_bin)` | `omca-mcp.py:46` | **BEFORE `mcp.run()` — inside `if __name__ == "__main__":`** | No — single global assignment |
| 17 | `print(f"omca MCP server starting (ast-grep: {sg_bin})", ...)` | `omca-mcp.py:47` | **BEFORE `mcp.run()`** | Minimal — stderr write |
| 18 | `mcp.run()` | `omca-mcp.py:48` | **RPC LOOP START** | Blocks — enters stdio MCP event loop |

### §1a — Module-level I/O scan (import time)

All seven tool modules (`ast`, `boulder`, `catalog`, `evidence`, `filesystem`, `notepad`, `validate_plan_write`) and `_common` were read end-to-end. Their top-level scope contains only:

- Constant/literal assignments (`SUPPORTED_LANGUAGES`, `LANG_EXTENSIONS`, `TIMEOUT`, regex patterns, denylist strings)
- Type alias definitions (`SupportedLang = Literal[...]`)
- `class ToolError(Exception): pass`
- Module-level `_SG_BIN: str | None = None` in `ast.py`

No module performs filesystem access, subprocess spawning, or network calls at import time. Import overhead is purely in-memory.

**One import-time coupling to note**: `catalog.py` imports `discover_binary` and `get_sg_bin` symbols from `tools.ast` at line 14. This is a symbol import only — it does not call either function. However, `health_check` (registered by `catalog.register()`) calls `discover_binary()` lazily when invoked, falling back gracefully via `try/except SystemExit`. This is safe — no startup I/O.

---

## 2. Latency Gap Analysis

### Verdict: NO ordering bug found

The suspected bug ("`ast_tools.discover_binary()` running AFTER `mcp.run()`") is **not present** in the current code. `discover_binary()` and `set_sg_bin()` are both called at lines 45-46, inside the `if __name__ == "__main__":` guard, **before** `mcp.run()` at line 48.

### What `discover_binary()` actually does (latency profile)

`ast.py:95-128` — three code paths:

1. **`$AST_GREP_BIN` env var set and found in PATH**: `shutil.which()` call (~0.1 ms). Fastest path.
2. **`$AST_GREP_BIN` not set — iterate `("ast-grep", "sg")`**: `shutil.which()` per name (~0.1 ms each) then `subprocess.run([path, "--version"], timeout=5)`. The subprocess exec is the only non-trivial cost: typically **5–50 ms** on a warm system.
3. **Binary not found**: `sys.exit(1)` — server aborts before `mcp.run()`.

### Measurable delay to first `initialize` reply

The call to `discover_binary()` runs **synchronously before `mcp.run()`**, so its latency adds directly to process startup time (the interval between `python omca-mcp.py` and the server accepting its first `initialize` RPC).

Empirical estimate:
- Path 1: ~0 ms incremental (env lookup + `shutil.which`)
- Path 2: ~10–60 ms (subprocess exec of `sg --version` or `ast-grep --version`)
- Path 3: up to `5 s` per candidate if something named `sg` exists in PATH but hangs (timeout guard at line 116 catches this)

On a clean install where `ast-grep` is in PATH as the first candidate, path 2 is the normal case. The 10–60 ms adds to process startup but is not perceptible to a user initiating a Claude Code session (the MCP handshake itself takes hundreds of ms over stdio).

### Other startup latency contributors

None of the `register()` calls (steps 5-11) perform any I/O. FastMCP registration is pure dict insertion. The signal handler installations (steps 12, 14) are near-zero syscalls.

**Conclusion**: Cold-start latency from I/O is exclusively from `discover_binary()` (~10–60 ms typical), and it already runs pre-`mcp.run()` in the correct position.

---

## 3. Corrected Ordering Proposal

Since the current ordering is already correct, no reordering is required. The proposed "corrected" ordering is the current ordering — documented here for clarity and as a reference for future contributors.

```
[1]  imports (pure, no I/O)
[2]  FastMCP("omca") construction
[3]  *.register(mcp) calls — pure tool registration, _SG_BIN still None
[4]  signal handler installation (SIGINT ignore, SIGTERM graceful exit)
[5]  if __name__ == "__main__":
         discover_binary()       ← I/O here, BEFORE mcp.run()
         set_sg_bin(sg_bin)      ← sets _SG_BIN; tools now fully armed
         print startup banner
         mcp.run()               ← RPC loop starts; tools callable
```

### Rationale per step

| Step | Rationale |
|------|-----------|
| `register()` calls before `discover_binary()` | Safe: tool closures reference `_SG_BIN` lazily via the module global. They read `_SG_BIN` only when called, not at registration. `run_command()` raises `ToolError("ast-grep binary not initialized")` if `_SG_BIN is None`, which is the correct failure mode for premature calls. |
| `discover_binary()` before `mcp.run()` | Correct: ensures `_SG_BIN` is set before any RPC can reach an AST tool. Avoids a race where a rapid `ast_search` call arrives before discovery completes. |
| `set_sg_bin()` immediately after `discover_binary()` | Correct: atomic module-global assignment. |
| Signal handlers before `mcp.run()` | Correct: ensures SIGTERM is handled gracefully even during a slow startup (edge case: if `discover_binary()` takes the 5 s timeout path). |

### One optional micro-improvement (low priority, not a bug fix)

The comment `# Module-level binary reference — set by register()` at `ast.py:131` is misleading — `_SG_BIN` is set by the entry point's `set_sg_bin()` call, not by `register()`. A one-line comment fix would improve clarity for future readers. This is cosmetic; T9 may address it or skip it.

---

## 4. Optional Follow-up: Advisory `omca.server_ready` Heartbeat Tool

Per plan constraint (line 203): this advisory tool is **OUT OF SCOPE** unless trivial. Given that the ordering is already correct and startup latency is bounded (10–60 ms), the heartbeat tool provides no observable benefit. **Recommendation: skip.**

---

## 5. Risks

Since no code changes are proposed, there are no risk items from reordering.

For completeness, risks that *would* apply if someone attempted to move `discover_binary()` post-`mcp.run()` (the scenario this audit was written to prevent):

| Risk | Description |
|------|-------------|
| AST tool calls before binary ready | Any `ast_search`, `ast_replace`, `ast_find_rule`, `ast_dump_tree`, `ast_test_rule` call arriving before `set_sg_bin()` completes would raise `ToolError("ast-grep binary not initialized")`. FastMCP surfaces this as an MCP error response — not a crash, but a confusing first-use failure. |
| `health_check` false negative | `health_check` in `catalog.py` calls `discover_binary()` directly when `get_sg_bin() is None`. If `_SG_BIN` is unset at first `health_check` call, it re-runs discovery. This is benign but redundant — it means two subprocess execs of `ast-grep --version` on cold start. |
| Signal handler window | If `mcp.run()` were called before signal handlers are installed, a SIGTERM arriving during the subprocess exec inside `discover_binary()` would use the default handler (process termination without cleanup). Current ordering (signal install before `mcp.run()`) closes this window. |

---

## 6. Summary

| Question | Answer |
|----------|--------|
| Is `discover_binary()` before or after `mcp.run()`? | **BEFORE** (`omca-mcp.py:45`, `mcp.run()` at line 48) |
| Is there a startup ordering bug? | **No** |
| Does any `register()` call do I/O? | **No** — all seven modules register pure closures |
| Does any module do I/O at import time? | **No** |
| Is the `_SG_BIN` race possible? | **No** — `set_sg_bin()` completes synchronously before `mcp.run()` |
| Recommended T9 scope | **Minor polish only**: fix misleading comment at `ast.py:131`; no structural changes needed |
