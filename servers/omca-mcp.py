#!/usr/bin/env python3
"""
omca-mcp — MCP server for oh-my-claudeagent.
Provides structural code search (ast-grep), work plan tracking (boulder),
verification evidence, subagent learning notepads, and filesystem access
for sandbox-scoped subagents.
"""

import signal
import sys

from mcp.server.fastmcp import FastMCP

from tools import (
    ast as ast_tools,
    boulder,
    catalog,
    evidence,
    filesystem,
    notepad,
    validate_plan_write,
)

mcp = FastMCP("omca")

ast_tools.register(mcp)
boulder.register(mcp)
evidence.register(mcp)
filesystem.register(mcp)
notepad.register(mcp)
catalog.register(mcp)
validate_plan_write.register(mcp)


signal.signal(signal.SIGINT, signal.SIG_IGN)


def _graceful_exit(_signum, _frame):
    sys.exit(0)


signal.signal(signal.SIGTERM, _graceful_exit)

# I/O init (discover_binary) must stay before mcp.run(). See docs/design/cold-start-ordering.md.
if __name__ == "__main__":
    sg_bin = ast_tools.discover_binary()
    ast_tools.set_sg_bin(sg_bin)
    print(f"omca MCP server starting (ast-grep: {sg_bin})", file=sys.stderr)
    mcp.run()
