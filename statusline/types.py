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
    exceeds_200k_tokens: bool
    cwd: str
    session_name: str
    session_id: str
    version: str
    transcript_path: str
    total_input_tokens: int
    total_output_tokens: int
    total_api_duration_ms: int


class GitInfo(TypedDict, total=False):
    is_git: str
    git_dir: str
    branch: str
    staged: str
    modified: str
    untracked: str
    remote: str
    remote_fetched_at: str
