---
globs: servers/*.py
description: Python conventions for oh-my-claudeagent MCP server code
---

When editing Python MCP server files:

- **ruff config**: target py310, line-length 88. Rules: E, F, B, C4, SIM, I, UP, PIE, PGH, RUF. E501 ignored (handled by formatter).
- **B008 ignored globally** — FastMCP requires `Field()` in function parameter defaults for tool descriptions. This is intentional, not a bug.
- **Formatting**: 4-space indent, LF line endings. Run `uv run --project servers ruff format servers/`.
- **Linting**: `uv run --project servers ruff check servers/`.
- **Dependencies**: managed via `uv run --project servers`. Add to `servers/pyproject.toml`, then `uv lock --project servers`.
- **MCP patterns**: use FastMCP decorators (`@mcp.tool()`). Tool parameters use `Field()` for descriptions.
- **No root pyproject.toml** — Python tooling is isolated to the `servers/` subdirectory.
- **MCP tool description cap**: Keep tool docstrings under 2KB (Claude Code v2.1.84+ truncates at this limit).
