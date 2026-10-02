"""TypedDict for the subagent status line payload."""

from __future__ import annotations

from typing import TypedDict


class SubagentStatuslinePayload(TypedDict, total=False):
    """Payload for the ``subagentStatusLine`` hook.

    ``columns`` is the PTY width, which only this hook reports.
    """

    tasks: list
    cwd: str
    columns: int
