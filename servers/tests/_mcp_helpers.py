"""Shared helpers for driving a live MCP server in tests."""

from __future__ import annotations

import asyncio
from typing import Any


def call_tool(server: Any, name: str, args: dict) -> str:
    """Call an MCP tool synchronously and return its text result."""
    result = asyncio.run(server.call_tool(name, args))
    if result.structured_content is not None:
        raise AssertionError(
            f"tool {name!r} returned structured_content, which means it declares "
            "an outputSchema. Claude Code discards text content whenever "
            "structuredContent is present; register the tool with "
            "structured_output=False."
        )
    return result.content[0].text
