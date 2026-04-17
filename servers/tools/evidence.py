"""Verification evidence logging tools."""

import json
import os
import time

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from tools._common import EVIDENCE_FILE, _read_json, _state_dir, _write_json


def register(mcp: FastMCP) -> None:
    """Register all evidence tools on the given FastMCP instance."""

    @mcp.tool()
    def evidence_log(
        evidence_type: str = Field(
            description="Evidence type: build, test, lint, manual, or final_verification_f1..f4 (final verification wave: F1 plan compliance, F2 code quality, F3 manual QA, F4 scope fidelity). Called after verification commands."
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
            description="SHA-256 of the active plan file; attach on F1-F4 entries to scope verification evidence to the current plan run. Leave empty for build/test/lint/manual entries.",
        ),
    ) -> str:
        """REQUIRED after every build/test/lint command — task completion is blocked without this. Append a timestamped verification evidence entry. Use immediately after running any verification command (just test, just lint, just build, etc.). Set plan_sha256 on final_verification_f1..f4 entries to scope evidence to a specific plan run. Returns confirmation with total evidence entry count."""
        state = _state_dir(working_directory)
        path = os.path.join(state, EVIDENCE_FILE)
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
        path = os.path.join(state, EVIDENCE_FILE)
        data = _read_json(path)
        if not data or not data.get("entries"):
            return "No verification evidence recorded."
        return json.dumps(data, indent=2)
