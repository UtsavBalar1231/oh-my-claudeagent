# Startup ordering invariant, omca-mcp.py

`servers/omca-mcp.py:48` carries a one-line comment pointing here. This file is the derivation.

## The invariant

`ast_tools.discover_binary()` and `ast_tools.set_sg_bin()` must run before `mcp.run()`, and the
signal handlers must be installed before both.

```
imports (pure, no I/O)
FastMCP("omca") construction
*.register(mcp) calls          pure tool registration, _SG_BIN still None
signal handlers                SIGINT ignore, SIGTERM immediate exit
if __name__ == "__main__":
    discover_binary()          the only I/O in startup, and it belongs here
    set_sg_bin(sg_bin)         tools now armed
    mcp.run()                  RPC loop starts; tools callable
```

## Why each position

| Step | Reason |
|---|---|
| `register()` before `discover_binary()` | Tool closures read the `_SG_BIN` module global lazily, only when called. `run_command()` raises `ToolError("ast-grep binary not initialized")` when `_SG_BIN` is `None`, which is the correct failure mode for a premature call. |
| `discover_binary()` before `mcp.run()` | `_SG_BIN` is set before any RPC can reach an AST tool, so a fast `ast_search` cannot race discovery. |
| Signal handlers before `mcp.run()` | SIGTERM is handled even during a slow startup, such as the 5 s subprocess timeout path inside `discover_binary()`. |

No `register()` call performs I/O; FastMCP registration is dict insertion. No tool module under
`servers/tools/` performs filesystem, subprocess, or network access at import time. Their
top-level scope holds constants, type aliases, exception classes, and `_SG_BIN: str | None`.
`catalog.py` imports `discover_binary` and `get_sg_bin` as symbols but calls neither at import
time; `health_check` calls `discover_binary()` lazily when invoked.

## Latency

`discover_binary()` is the only I/O cost in startup, and it has three paths:

1. `$AST_GREP_BIN` set and found in PATH: `shutil.which()`, roughly 0.1 ms.
2. Not set, so iterate `("ast-grep", "sg")`: `shutil.which()` per name, then
   `subprocess.run([path, "--version"], timeout=5)`. Typically 10 to 60 ms, and the normal case
   on a clean install.
3. Not found: `sys.exit(1)` before `mcp.run()`.

10 to 60 ms is not perceptible against an MCP handshake that takes hundreds of ms over stdio.

## Risks of moving `discover_binary()` after `mcp.run()`

| Risk | Effect |
|---|---|
| AST calls before the binary is ready | Any `ast_search`, `ast_replace`, `ast_find_rule`, `ast_dump_tree`, or `ast_test_rule` arriving before `set_sg_bin()` raises `ToolError("ast-grep binary not initialized")`. FastMCP surfaces it as an MCP error, so it is a confusing first-use failure rather than a crash. |
| Redundant `health_check` discovery | `health_check` calls `discover_binary()` itself when `get_sg_bin()` is `None`, so cold start would exec `ast-grep --version` twice. |
| Signal handler window | A SIGTERM arriving during the `discover_binary()` subprocess exec would hit the default handler and terminate without cleanup. |
