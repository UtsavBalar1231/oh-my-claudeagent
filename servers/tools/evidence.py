"""Verification evidence logging tools."""

import json
import time

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from tools._common import (
    _evidence_new_path,
    _find_git_root,
    _load_evidence,
    _read_json,
    _state_dir,
    _write_json,
)


def register(mcp: FastMCP) -> None:
    """Register all evidence tools on the given FastMCP instance."""

    @mcp.tool()
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
        git_root = _find_git_root(working_directory)
        path = _evidence_new_path(git_root)
        data = _read_json(path)

        if "entries" not in data:
            data["entries"] = []

        entry = {
            "type": evidence_type,
            "command": command,
            "exit_code": exit_code,
            "output_snippet": output_snippet[:2000],
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        if verified_by:
            entry["verified_by"] = verified_by
        if plan_sha256:
            entry["plan_sha256"] = plan_sha256

        data["entries"].append(entry)
        _write_json(path, data)
        return f"Evidence recorded: {evidence_type} (exit {exit_code}), {len(data['entries'])} total entries"

    @mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
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
