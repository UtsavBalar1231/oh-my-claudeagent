# Servers

The `omca` MCP server: a FastMCP Python app exposing OMCA's tools (boulder plan
registry, evidence log, notepads, ast-grep search, filesystem helpers).

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

Python style, ruff config, and FastMCP/`Field()` patterns live in
`.claude/rules/python.md`. State file schemas these tools read and write live in
`.claude/rules/state-schemas.md`.
