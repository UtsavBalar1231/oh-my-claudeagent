"""TypedDict definitions for the statusline payload.

All TypedDicts use total=False to allow partial payloads.
Target: Python 3.10+
"""

from __future__ import annotations

from typing import TypedDict


class StatuslinePayload(TypedDict, total=False):
    model: dict
    workspace: dict
    context_window: dict
    cost: dict
    rate_limits: dict
    vim: dict
    agent: dict
    worktree: dict
    output_style: dict
    pr: dict  # PR info: number, url, review_state, kind ("mr" for a GitLab MR)
    exceeds_200k_tokens: bool
    cwd: str
    session_name: str
    session_id: str
    version: str
    transcript_path: str
    effort: dict
    thinking: dict


class SubagentStatuslinePayload(TypedDict, total=False):
    """Payload for the ``subagentStatusLine`` hook.

    ``columns`` is scoped here rather than to the main payload: only this hook
    reports the PTY width, so the main renderer falls back to the COLUMNS env var.
    """

    tasks: list
    cwd: str
    columns: int


class GitInfo(TypedDict, total=False):
    is_git: str
    git_dir: str
    branch: str
    staged: str
    modified: str
    untracked: str
    remote: str
    remote_fetched_at: str
