"""Agent catalog and categories tools."""

import json
import os
from pathlib import Path
from typing import Annotated

import yaml
from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations
from pydantic import Field

from tools import _boulder_core
from tools._common import AGENT_CATALOG_FILE, _state_dir, _write_json
from tools.ast import discover_binary, get_sg_bin


def register(mcp: MCPServer) -> None:
    """Register all catalog and concurrency tools on the given MCPServer instance."""

    _MODEL_COST_TIER = {
        "claude-fable-5-1": "premium",
        "claude-fable-5": "premium",
        "fable": "premium",
        "claude-opus-5-5": "expensive",
        "claude-opus-5": "expensive",
        "claude-opus-4-8": "expensive",
        "opus": "expensive",
        "claude-sonnet-5-5": "cheap",
        "claude-sonnet-5": "cheap",
        "sonnet": "cheap",
        "claude-haiku-4-5": "free",
        "haiku": "free",
    }

    @mcp.tool(
        annotations=ToolAnnotations(
            read_only_hint=True,
            idempotent_hint=True,
            open_world_hint=False,
        ),
        meta={
            "anthropic/searchHint": "agent roster with when_to_use, cost tier, and model, for delegation routing"
        },
        structured_output=False,
    )
    def agents_list(
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
        write_cache: Annotated[
            bool,
            Field(
                description="Also write the catalog to .omca/state/agent-catalog.json, which the SubagentStart hook reads for its delegation table. Pass true when the hook reports the catalog is missing."
            ),
        ] = False,
    ) -> str:
        """Return a JSON array with one entry per agent file in the plugin's agents/ directory: name, description (the frontmatter description), default_model (the frontmatter model alias, "sonnet" when absent), and cost_tier (premium for fable, expensive for opus, cheap for sonnet and unknown values, free for haiku). The Agent tool's own agent list already carries names and descriptions; use this when the model or cost tier matters. Read-only unless write_cache=true, which also writes .omca/state/agent-catalog.json for the SubagentStart hook."""
        _env_val = os.environ.get("CLAUDE_PLUGIN_ROOT")
        plugin_root = (
            Path(_env_val) if _env_val else Path(__file__).parent.parent.parent
        )
        agents_dir = plugin_root / "agents"

        catalog = []
        if agents_dir.is_dir():
            for md_file in sorted(agents_dir.glob("*.md")):
                content = md_file.read_text()
                if content.startswith("---"):
                    parts = content.split("---", 2)
                    if len(parts) >= 3:
                        fm = yaml.safe_load(parts[1]) or {}
                        name = fm.get("name", md_file.stem)
                        model = fm.get("model", "sonnet")
                        cost_tier = _MODEL_COST_TIER.get(model, "cheap")
                        catalog.append(
                            {
                                "name": name,
                                "description": fm.get("description", ""),
                                "default_model": model,
                                "cost_tier": cost_tier,
                            }
                        )

        if write_cache:
            state = _state_dir(working_directory)
            _write_json(os.path.join(state, AGENT_CATALOG_FILE), catalog)
        return json.dumps(catalog, indent=2)

    @mcp.tool(
        annotations=ToolAnnotations(
            read_only_hint=True, idempotent_hint=True, open_world_hint=False
        ),
        meta={"anthropic/searchHint": "agent category to model tier mapping"},
        structured_output=False,
    )
    def categories_list(
        working_directory: str = Field(
            default="",
            description="Unused — reads from plugin dir. Kept for API consistency.",
        ),
    ) -> str:
        """Return category-to-model mapping from categories.json. Use when selecting the right model tier for a task category. Returns JSON mapping of category names to model tier."""
        _env_val = os.environ.get("CLAUDE_PLUGIN_ROOT")
        plugin_root = (
            Path(_env_val) if _env_val else Path(__file__).parent.parent.parent
        )
        config_path = plugin_root / "servers" / "categories.json"
        if not config_path.exists():
            return json.dumps({"error": "categories.json not found"})
        try:
            data = json.loads(config_path.read_text())
            return json.dumps(data, indent=2)
        except json.JSONDecodeError:
            return json.dumps({"error": "categories.json is malformed"})

    @mcp.tool(
        annotations=ToolAnnotations(
            read_only_hint=True, idempotent_hint=True, open_world_hint=False
        ),
        meta={
            "anthropic/searchHint": "diagnose omca plugin state: ast-grep binary, state directory, key state files"
        },
        structured_output=False,
    )
    def health_check(
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """Diagnostic health check for the omca plugin. Verify ast-grep binary, state directory, and key state files. Use when MCP tools are failing or after plugin installation to diagnose configuration issues. Returns a system status report with OK/MISSING/absent for each component."""
        results = []
        # Check ast-grep
        try:
            binary = discover_binary() if get_sg_bin() is None else get_sg_bin()
        except SystemExit:
            binary = None
        if binary:
            results.append(f"ast-grep: OK ({binary})")
        else:
            results.append("ast-grep: NOT FOUND")
        # Check state dir
        state = _state_dir(working_directory)
        state_path = Path(state)
        if state_path.exists():
            results.append(f"state_dir: OK ({state})")
        else:
            results.append(f"state_dir: MISSING ({state})")
        # Check key state files
        # The evidence ledger lives in .omca/evidence/, beside state/, not inside it.
        for name, path in [
            ("session.json", state_path / "session.json"),
            (
                "verification-evidence.json",
                state_path.parent / "evidence" / "verification-evidence.json",
            ),
        ]:
            results.append(f"  {name}: {'exists' if path.exists() else 'absent'}")
        boulder_path = state_path / "boulder.json"
        if boulder_path.exists():
            try:
                plan_count = len(
                    _boulder_core.normalize(json.loads(boulder_path.read_text()))[
                        "plans"
                    ]
                )
            except (json.JSONDecodeError, OSError):
                plan_count = 0
            results.append(f"  boulder.json: {plan_count} plan(s)")
        else:
            results.append("  boulder.json: absent")
        return "\n".join(results)
