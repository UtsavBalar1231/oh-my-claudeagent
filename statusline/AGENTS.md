# Statusline

`cc-statusline`, a standalone daemon-backed status renderer for Claude Code. Own
Python project (`pyproject.toml`/`uv.lock`), separate from `servers/`.

## Layout

- `core.py`: rendering logic. Reads the statusline JSON payload, resolves the bound
  boulder plan, formats the multi-line/single-line output.
- `daemon.py` / `client.py` / `direct.py`: daemon architecture. `daemon.py` runs a
  long-lived process that pre-warms state; `client.py` talks to it over a socket;
  `direct.py` is the no-daemon fallback path.
- `git.py`: git branch/status/PR-segment collection.
- `config.py`: user-configurable thresholds and toggles.
- `subagent.py`: reads live subagent model info for display.
- `protocol.py` / `types.py`: the daemon wire protocol and shared type definitions.
- `tests/`: pytest suite (`just test-pytest` runs both `servers/` and `statusline/`).
- `README.md`: full user-facing description of what the statusline shows and how the
  daemon architecture works. Read that before this file for behavior questions.

## Conventions

Statusline reads `.omca/state/boulder.json` directly rather than going through the MCP
tool, since it must render outside a tool-call context. `servers/tools/_boulder_core.py`
is the authority on that file's schema and on `resolve_bound_plan`, which this code calls
with `strict=True`.
