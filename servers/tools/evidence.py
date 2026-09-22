"""Verification evidence logging tools."""

import json
import time
from typing import Literal

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
        evidence_type: Literal[
            "build", "test", "lint", "manual", "final_verification"
        ] = Field(
            description="Kind of evidence. final_verification is the end-of-plan completeness verdict. The plan Stop gate accepts only a final_verification entry with exit_code 0 whose plan_sha256 matches the plan file's current SHA-256; an entry without plan_sha256 matches any plan, and editing the plan after logging makes a scoped entry stop matching."
        ),
        command: str = Field(description="Command that was executed"),
        exit_code: int = Field(
            description="Exit code of the command. For final_verification, 0 records COMPLETE and any other value INCOMPLETE."
        ),
        output_snippet: str = Field(
            description="Relevant output snippet (truncated if needed)"
        ),
        verified_by: str = Field(default="", description="Agent or user who verified"),
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
        plan_sha256: str = Field(
            default="",
            description="Hex SHA-256 of the plan file's current bytes, the first field of `sha256sum <plan file>`. Set it on final_verification entries so the verdict applies only to this version of the plan; leave empty for other types.",
        ),
    ) -> str:
        """Append a timestamped entry to the project's verification evidence log (.omca/evidence/verification-evidence.json), the audit trail OMCA's gates read. Use it after each build, test, or lint run, with the run's real exit code (a failing run is still evidence), and once at the end of a plan for the final_verification verdict. Two gates read the log: a plan-bound session cannot stop until a final_verification entry matches the plan (see evidence_type), and when task tools are enabled a TaskCompleted hook refuses to close a task if a verification run finished after the log was last written. Entries are never removed and are shared by every session in the project. Returns a confirmation with the total entry count."""
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
        """Return every entry in the project's verification evidence log as JSON, oldest first, or a no-evidence message. The log is never cleared and is shared by all sessions in the project, so it holds entries from earlier sessions and other plans; there is no filter or paging, and each output_snippet is capped at 2,000 characters. Use it to confirm what was logged, for example evidence a subagent reports."""
        state = _state_dir(working_directory)
        entries = _load_evidence(state)
        if not entries:
            return "No verification evidence recorded."
        return json.dumps({"entries": entries}, indent=2)
