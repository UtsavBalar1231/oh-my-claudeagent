# Servers

The `omca` MCP server: an `MCPServer` Python app exposing OMCA's tools (boulder plan
registry, evidence log, notepads, ast-grep search, filesystem helpers).

It is built on the official `mcp` Python SDK 2.x, which implements MCP spec revision
2026-07-28 and serves both that revision and every 2025-era client from the same stdio
server.

## Layout

- `omca-mcp.py`: server entry point, launched via `uv run --project servers` from
  `.mcp.json`.
- `tools/`: one module per tool family (`boulder.py`, `evidence.py`, `notepad.py`,
  `ast.py`, `filesystem.py`, `catalog.py`, `validate_plan_write.py`). `_common.py` and
  `_boulder_core.py` hold shared, non-tool internals (session-id resolution, plan
  registry read logic). `boulder_resolve.py` is the bash-callable shim scripts use to
  read the same registry without hand-parsing JSON.
- `tests/`: pytest suite (`just test-pytest`), one `test_*.py` per tool module plus
  startup/latency checks.
- `categories.json`: model-tier routing table for OMCA agent categories.
- `pyproject.toml` / `uv.lock`: dependency management; add deps here, then
  `uv lock --project servers`.

## Conventions

- ruff targets py310 at line-length 88, rule set `E, F, B, C4, SIM, I, UP, PIE, PGH, RUF`.
  E501 is ignored because the formatter owns line length. B008 is ignored globally because
  `MCPServer` needs `Field()` in parameter defaults to carry tool descriptions.
- Format with `uv run --project servers ruff format servers/`, lint with
  `uv run --project servers ruff check servers/`. Four-space indent, LF endings.
- Define tools with `MCPServer` decorators (`@mcp.tool()`) and describe each parameter with
  `Field()`. Keep a tool docstring under 2KB; Claude Code truncates past that.
- There is no root `pyproject.toml`. Python tooling stays inside `servers/`.

The state files these tools read and write are `boulder.json` (a session-bound plan
registry keyed `plans[plan_name]` and `bindings[session_id]`),
`verification-evidence.json` (the append-only evidence log, `output_snippet` capped at
2000 characters), and the notepad tree under `.omca/state/notepads/`. Read
`servers/tools/_boulder_core.py` for the resolution ladder rather than hand-parsing
`boulder.json` anywhere else.
