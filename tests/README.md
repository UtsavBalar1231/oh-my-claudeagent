# Tests

This directory contains behavioral and integration tests for oh-my-claudeagent.

## Directory Structure

```
tests/
  bats/
    bats-core/      # BATS test framework (git submodule)
    hooks/          # BATS behavioral tests for hook scripts
  evals/            # Eval tasks and run scripts
  fixtures/
    hooks/          # JSON payloads for hook validation (validate-plugin.sh)
    mcp/            # JSON-RPC requests for MCP server validation
```

Python MCP tool tests live alongside the server code:

```
servers/tests/      # pytest tests for omca MCP tools
```

## Running Tests Locally

```bash
# All layers at once
just test-all

# Layer 1: structural validation (claims + hooks format)
just test

# Layer 2: BATS behavioral tests (hook behavior, content assertions)
git submodule update --init   # pull bats-core if not present
just test-bats

# Layer 3: pytest MCP tool tests
just test-pytest

# Layer 4: MCP server startup + tool listing (requires ast-grep)
just test-mcp
```

## Adding a New BATS Hook Test

1. Create `tests/bats/hooks/your-hook-name.bats` by copying an existing file as a template.
2. Each test function follows the pattern:

```bash
@test "your-hook: description of expected behavior" {
  INPUT='{"key": "value"}'
  OUTPUT=$(echo "$INPUT" | bash scripts/your-hook.sh)
  [ $? -eq 0 ]
  echo "$OUTPUT" | grep -q "expected_string"
}
```

3. Run `just test-bats` to verify locally before committing.

## Adding a New pytest MCP Tool Test

1. Create `servers/tests/test_your_tool.py` by copying an existing `test_*.py` file.
2. Each test follows the pattern:

```python
def test_your_tool_behavior(tmp_path):
    # Arrange: set up state
    # Act: call the tool function directly
    result = your_tool(param="value")
    # Assert: check output
    assert "expected" in result
```

3. Run `just test-pytest` to verify locally.

## CI Integration

CI runs all four layers on every push and pull request to `main`:

| Job | Command | Trigger |
|-----|---------|---------|
| `validate` | `validate-plugin.sh --check claims --check hooks` | All pushes |
| `test-bats` | `bats tests/bats/hooks/` | All pushes (submodules: true) |
| `test-pytest` | `pytest servers/tests/ -v --tb=short` | All pushes |
| `lint-python` | `ruff format --check` + `ruff check` | All pushes |
| `lint-shell` | `shellcheck scripts/*.sh` | All pushes |

Note: the `validate` job's MCP check (`--check mcp`) is excluded from CI because it requires the ast-grep CLI binary, which is not available in the standard CI runner. Run `just test-mcp` locally after changes to the MCP server.
