#!/usr/bin/env python3
"""
omca-mcp — MCP server for oh-my-claudeagent.
Provides structural code search (ast-grep), work plan tracking (boulder),
verification evidence, subagent learning notepads, and filesystem access
for sandbox-scoped subagents.
"""

import os
import signal
import sys

from mcp.server.mcpserver import MCPServer

from tools import (
    ast as ast_tools,
    boulder,
    catalog,
    evidence,
    filesystem,
    notepad,
    sessions,
    validate_plan_write,
)

INSTRUCTIONS = """\
oh-my-claudeagent (OMCA) tools: verification evidence, work-plan tracking, notepads that \
survive compaction, structural code search, and reads outside the project root. State lives \
under `.omca/` in the project root and is written only through these tools; never hand-edit \
those files.

Reach for a tool when:

- You just ran a build, test, or lint command. Record it with `evidence_log` — OMCA hooks \
block task completion until evidence exists. `evidence_read` reviews what is already logged.
- You are executing a multi-step plan. `boulder_write` registers it and binds this session; \
`boulder_progress` reports completed and remaining checkboxes plus the next task.
- You learned something that must outlive a compaction: a discovery, blocker, decision, or \
open problem. `notepad_write` persists it, `notepad_read` and `notepad_list` recall it, \
`notepad_compact` shrinks a section that grew large.
- You are searching code by structure rather than text — function signatures, class shapes, \
import forms, call patterns. `ast_search` beats grep whenever the target is syntactic. \
`ast_find_rule` handles context-sensitive matches such as calls inside a class, \
`ast_test_rule` validates a rule on a snippet first, `ast_dump_tree` shows the syntax tree \
when a pattern will not match, and `ast_replace` rewrites AST-safely (preview with dry_run).
- You need a file outside the project root, where the built-in Read tool is scoped out. \
`file_read` returns line-numbered content with a token estimate and offset/limit paging.
- You need something from an earlier session here. `session_search` scans local transcripts.
- You are choosing a delegation target. `agents_list` gives when_to_use, cost tier, and model \
per agent; `categories_list` maps categories to model tiers.
- The plugin itself looks broken. `health_check` reports on the ast-grep binary and state files.
"""

mcp = MCPServer("omca", instructions=INSTRUCTIONS)

ast_tools.register(mcp)
boulder.register(mcp)
evidence.register(mcp)
filesystem.register(mcp)
notepad.register(mcp)
catalog.register(mcp)
sessions.register(mcp)
validate_plan_write.register(mcp)


def _terminate_immediately(_signum, _frame):
    # Raising SystemExit from AnyIO's event loop can spin while cancelling stdio tasks.
    os._exit(0)


def install_signal_handlers() -> None:
    """Ignore SIGINT and exit hard on SIGTERM."""
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, _terminate_immediately)


if __name__ == "__main__":
    install_signal_handlers()
    sg_bin = ast_tools.discover_binary()
    ast_tools.set_sg_bin(sg_bin)
    print(f"omca MCP server starting (ast-grep: {sg_bin})", file=sys.stderr)
    mcp.run()
