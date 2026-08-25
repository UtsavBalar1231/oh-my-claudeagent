"""Verification evidence logging tools."""

import json
import time

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations
from pydantic import Field

from tools._common import (
    _evidence_new_path,
    _file_lock,
    _find_git_root,
    _load_evidence,
    _read_json,
    _state_dir,
    _write_json,
)

SNIPPET_MAX_CHARS = 2000
# Raises the client's persist-to-disk threshold for this tool's text result.
# A full evidence log is many 2000-char snippets; 100000 holds ~50 of them,
# well under the client's 500000 ceiling.
EVIDENCE_MAX_RESULT_CHARS = 100_000


def _do_evidence_log(
    evidence_type: str,
    command: str,
    exit_code: int,
    output_snippet: str,
    verified_by: str,
    working_directory: str,
    plan_sha256: str,
) -> str:
    """Append one evidence entry under an exclusive lock."""
    git_root = _find_git_root(working_directory)
    path = _evidence_new_path(git_root)

    entry = {
        "type": evidence_type,
        "command": command,
        "exit_code": exit_code,
        "output_snippet": output_snippet[:SNIPPET_MAX_CHARS],
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if verified_by:
        entry["verified_by"] = verified_by
    if plan_sha256:
        entry["plan_sha256"] = plan_sha256

    with _file_lock(path + ".lock"):
        data = _read_json(path)
        entries = data.setdefault("entries", [])
        entries.append(entry)
        _write_json(path, data)
        total = len(entries)

    return (
        f"Evidence recorded: {evidence_type} (exit {exit_code}), {total} total entries"
    )


def register(mcp: MCPServer) -> None:
    """Register all evidence tools on the given MCPServer instance."""

    @mcp.tool(
        annotations=ToolAnnotations(
            title="Log verification evidence",
            read_only_hint=False,
            destructive_hint=False,
            idempotent_hint=False,
            open_world_hint=False,
        ),
        meta={
            "anthropic/searchHint": "record a build, test, or lint verification result; required before any completion claim",
            "anthropic/alwaysLoad": True,
        },
        structured_output=False,
    )
    def evidence_log(
        evidence_type: str = Field(
            description="Evidence type: build, test, lint, manual, or final_verification (end-of-plan completeness verdict; one logged entry opens the gate permanently). Called after verification commands."
        ),
        command: str = Field(description="Command that was executed"),
        exit_code: int = Field(description="Exit code of the command"),
        output_snippet: str = Field(
            description="Relevant output snippet (truncated if needed)"
        ),
        verified_by: str = Field(default="", description="Agent or user who verified"),
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
        plan_sha256: str = Field(
            default="",
            description="SHA-256 of the active plan file; attach on final_verification entries to scope evidence to a specific plan run. Leave empty for build/test/lint/manual entries.",
        ),
    ) -> str:
        """REQUIRED after every build/test/lint command -- task completion is blocked without this. Append a timestamped verification evidence entry. Use immediately after running any verification command (just test, just lint, just build, etc.). Set plan_sha256 on final_verification entries to scope evidence to a specific plan run. Returns confirmation with total evidence entry count."""
        return _do_evidence_log(
            evidence_type,
            command,
            exit_code,
            output_snippet,
            verified_by,
            working_directory,
            plan_sha256,
        )

    @mcp.tool(
        annotations=ToolAnnotations(
            read_only_hint=True,
            idempotent_hint=True,
            open_world_hint=False,
        ),
        meta={
            "anthropic/searchHint": "review all logged verification evidence before claiming a task complete",
            "anthropic/maxResultSizeChars": EVIDENCE_MAX_RESULT_CHARS,
        },
        structured_output=False,
    )
    def evidence_read(
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """Read all accumulated verification evidence records. Use before claiming task completion to review what has been verified, or when an orchestrator needs to confirm subagent work. Returns full JSON evidence log or a no-evidence message."""
        state = _state_dir(working_directory)
        entries = _load_evidence(state)
        if not entries:
            return "No verification evidence recorded."
        return json.dumps({"entries": entries}, indent=2)
