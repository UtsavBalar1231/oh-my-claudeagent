"""Agent catalog, categories, and concurrency status tools."""

import contextlib
import json
import os
import time
from pathlib import Path

import yaml
from mcp.server.fastmcp import FastMCP
from pydantic import Field

from tools._common import AGENT_CATALOG_FILE, _state_dir, _write_json
from tools.ast import discover_binary, get_sg_bin


def register(mcp: FastMCP) -> None:
    """Register all catalog and concurrency tools on the given FastMCP instance."""

    @mcp.tool()
    def agents_list(
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """Return structured catalog of all agents with orchestration metadata. Use at session start for routing decisions — provides when_to_use, cost_tier, and model for each agent. Writes agent-catalog.json cache for hooks. Returns JSON array of agent entries."""
        _env_val = os.environ.get("CLAUDE_PLUGIN_ROOT")
        plugin_root = (
            Path(_env_val) if _env_val else Path(__file__).parent.parent.parent
        )
        agents_dir = plugin_root / "agents"
        metadata_path = plugin_root / "servers" / "agent-metadata.json"

        # Load legacy metadata as fallback for agents without frontmatter fields
        legacy_metadata: dict = {}
        if metadata_path.exists():
            with contextlib.suppress(json.JSONDecodeError):
                legacy_metadata = json.loads(metadata_path.read_text())

        catalog = []
        if agents_dir.is_dir():
            for md_file in sorted(agents_dir.glob("*.md")):
                content = md_file.read_text()
                if content.startswith("---"):
                    parts = content.split("---", 2)
                    if len(parts) >= 3:
                        fm = yaml.safe_load(parts[1]) or {}
                        name = fm.get("name", md_file.stem)
                        # Prefer frontmatter fields; fall back to legacy JSON metadata
                        meta = legacy_metadata.get(name, {})
                        triggers = fm.get("triggers", [])
                        key_trigger = (
                            triggers[0]
                            if isinstance(triggers, list) and triggers
                            else (
                                triggers
                                if isinstance(triggers, str)
                                else meta.get("key_trigger", "")
                            )
                        )
                        catalog.append(
                            {
                                "name": name,
                                "description": fm.get("description", ""),
                                "default_model": fm.get("model", "sonnet"),
                                "agent_category": meta.get(
                                    "agent_category", "specialist"
                                ),
                                "cost_tier": fm.get(
                                    "costTier", meta.get("cost_tier", "cheap")
                                ),
                                "preferred_category": fm.get(
                                    "category",
                                    meta.get("preferred_category", "standard"),
                                ),
                                "when_to_use": meta.get("when_to_use", ""),
                                "when_not_to_use": meta.get("when_not_to_use", ""),
                                "key_trigger": key_trigger,
                            }
                        )

        state = _state_dir(working_directory)
        cache_path = os.path.join(state, AGENT_CATALOG_FILE)
        _write_json(cache_path, catalog)
        return json.dumps(catalog, indent=2)

    @mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
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

    @mcp.tool()
    def concurrency_status(
        working_directory: str = Field(
            default="", description="Project root (auto-detected from git)"
        ),
    ) -> str:
        """Diagnostic tool for inspecting active agent state and tracking metrics. Prunes stale entries older than 15 minutes as a side effect. Returns JSON with active agent list, per-model counts, and total."""
        state = _state_dir(working_directory)
        active_path = os.path.join(state, "active-agents.json")

        try:
            with open(active_path) as f:
                agents = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return json.dumps({"active": [], "counts": {}, "total": 0})

        # Prune stale entries (>15 min)
        cutoff = time.time() - 900
        agents = [a for a in agents if a.get("started_epoch", 0) > cutoff]

        # Write back pruned list
        _write_json(active_path, agents)

        # Count by model
        counts: dict[str, int] = {}
        for a in agents:
            model = a.get("model", "unknown")
            counts[model] = counts.get(model, 0) + 1

        return json.dumps(
            {
                "active": agents,
                "counts": counts,
                "total": len(agents),
            },
            indent=2,
        )

    @mcp.tool(annotations={"readOnlyHint": True, "idempotentHint": True})
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
        for name in ["session.json", "boulder.json", "verification-evidence.json"]:
            path = state_path / name
            results.append(f"  {name}: {'exists' if path.exists() else 'absent'}")
        return "\n".join(results)
