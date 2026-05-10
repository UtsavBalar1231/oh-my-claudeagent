"""Plan write validator — MCP tool hook for PreToolUse Write/Edit on plan files."""

import json
import re

from mcp.server.fastmcp import FastMCP
from pydantic import Field

# ---------------------------------------------------------------------------
# Plan-detection helpers (mirrors plan-checkbox-verify.sh logic exactly)
# ---------------------------------------------------------------------------

_PLAN_PATH_RE = re.compile(r"(/plans/[^/]+\.md$)")
_CHECKBOX_RE = re.compile(r"^- \[ ?\] \d+\.", re.MULTILINE)
_AGENT_BASENAME_RE = re.compile(r"^[^/]+-agent-[^/]+\.md$")


def _is_plan_path(file_path: str) -> bool:
    """Return True when file_path looks like a plan file path."""
    return bool(_PLAN_PATH_RE.search(file_path))


def _is_plan_content(content: str, basename: str) -> bool:
    """Heuristic: content has plan headers or filename matches agent convention."""
    if re.search(r"^## TODOs", content, re.MULTILINE):
        return True
    if re.search(r"^## Work Objectives", content, re.MULTILINE):
        return True
    return bool(_AGENT_BASENAME_RE.match(basename))


def _has_checkboxes(content: str) -> bool:
    return bool(_CHECKBOX_RE.search(content))


def _basename(file_path: str) -> str:
    return file_path.rsplit("/", 1)[-1] if "/" in file_path else file_path


def _deny(reason: str) -> str:
    """Return hookSpecificOutput JSON that denies a PreToolUse call."""
    return json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }
        }
    )


def _allow() -> str:
    """Return empty JSON object — no-op allow."""
    return "{}"


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


def register(mcp: FastMCP) -> None:
    """Register the validate_plan_write tool on the given FastMCP instance."""

    @mcp.tool()
    def validate_plan_write(
        tool_name: str = Field(
            description="The triggering tool name: 'Write' or 'Edit'."
        ),
        file_path: str = Field(
            description="Absolute path of the file being written or edited."
        ),
        content: str = Field(
            default="",
            description="Full file content (Write tool). Leave empty for Edit.",
        ),
        new_string: str = Field(
            default="",
            description="Replacement string (Edit tool). Leave empty for Write.",
        ),
        old_string: str = Field(
            default="",
            description="Original string (Edit tool, optional diff context).",
        ),
    ) -> str:
        """Validate that plan files written via Write or Edit contain numbered checkboxes.

        Called as a PreToolUse mcp_tool hook for Write and Edit events.
        Returns a JSON deny decision (hookSpecificOutput.permissionDecision=deny) when
        a plan file has no '- [ ] N.' checkboxes; returns '{}' (allow) otherwise.

        Branching by tool:
          Write → inspects `content` parameter (full file body).
          Edit  → inspects `new_string` parameter (the replacement text).
        """
        # Only react to Write and Edit
        if tool_name not in ("Write", "Edit"):
            return _allow()

        # Only react to plan-path files
        if not _is_plan_path(file_path):
            return _allow()

        # Write uses full file content; Edit uses the replacement string
        body = content if tool_name == "Write" else new_string

        basename = _basename(file_path)

        # Is this actually a plan document?
        if not _is_plan_content(body, basename):
            return _allow()

        # Does it have the required numbered checkboxes?
        if not _has_checkboxes(body):
            reason = (
                f"[PLAN-CHECKBOX-VERIFY] Plan file {file_path} has no - [ ] N. "
                "checkboxes. Prometheus must emit at least one numbered task. "
                "This is the load-bearing enforcement of orchestration discipline."
            )
            return _deny(reason)

        return _allow()
