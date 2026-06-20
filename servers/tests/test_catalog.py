"""Tests for catalog MCP tools (agents_list, categories_list, health_check)."""

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

import tools.catalog as catalog_module

REPO_ROOT = Path(__file__).parent.parent.parent


def _get_tools():
    """Extract tool functions from catalog module."""
    captured = {}
    mock_mcp = MagicMock()

    def tool_decorator(*args, **kwargs):
        def wrapper(fn):
            captured[fn.__name__] = fn
            return fn

        if args and callable(args[0]):
            fn = args[0]
            captured[fn.__name__] = fn
            return fn
        return wrapper

    mock_mcp.tool = tool_decorator
    catalog_module.register(mock_mcp)
    return captured


@pytest.fixture
def tools():
    return _get_tools()


# --- agents_list ---


def test_agents_list_returns_known_agents(tools, monkeypatch, working_dir):
    """agents_list returns a list containing expected agent names when CLAUDE_PLUGIN_ROOT is set."""
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(REPO_ROOT))
    result = tools["agents_list"](working_directory=working_dir)
    data = json.loads(result)
    assert isinstance(data, list)
    assert len(data) > 0
    names = [entry["name"] for entry in data]
    # These agents are known to exist in the repo
    assert "sisyphus" in names
    assert "explore" in names
    assert "executor" in names


def test_agents_list_returns_required_fields(tools, monkeypatch, working_dir):
    """Each agent entry has the required metadata fields."""
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(REPO_ROOT))
    result = tools["agents_list"](working_directory=working_dir)
    data = json.loads(result)
    required_fields = {"name", "description", "default_model"}
    for entry in data:
        for field in required_fields:
            assert field in entry, f"Agent entry missing field '{field}': {entry}"


# --- categories_list ---


def test_categories_list_returns_valid_json(tools, monkeypatch):
    """categories_list returns parseable JSON."""
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(REPO_ROOT))
    result = tools["categories_list"](working_directory="")
    data = json.loads(result)
    assert isinstance(data, dict)
    assert "error" not in data


def test_categories_list_has_expected_categories(tools, monkeypatch):
    """categories_list contains known category entries."""
    monkeypatch.setenv("CLAUDE_PLUGIN_ROOT", str(REPO_ROOT))
    result = tools["categories_list"](working_directory="")
    data = json.loads(result)
    # categories.json should have at least one entry
    assert len(data) > 0


# --- health_check ---


def test_health_check_returns_state_dir_status(tools, working_dir):
    """health_check reports OK for an existing state directory."""
    result = tools["health_check"](working_directory=working_dir)
    assert "state_dir: OK" in result


def test_health_check_reports_ast_grep_status(tools, working_dir):
    """health_check reports ast-grep binary status (OK or NOT FOUND)."""
    result = tools["health_check"](working_directory=working_dir)
    assert "ast-grep:" in result
