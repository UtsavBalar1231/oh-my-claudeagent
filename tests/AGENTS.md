# Tests

Behavioral and integration tests for the plugin, split across four layers. Python
MCP tool tests live alongside their source in `servers/tests/` and `statusline/tests/`
rather than here.

## Layout

- `bats/hooks/`: BATS behavioral tests for hook scripts (`just test-bats`).
  `bats/bats-core` is a git submodule; run `git submodule update --init` first.
- `bats/unit/`: BATS unit tests for shared shell helpers.
- `fixtures/hooks/`: JSON payloads used by `validate-plugin.sh` and hook tests.
- `fixtures/mcp/`: JSON-RPC requests and the golden `expected-tools.json` baseline
  for `just test-mcp`.
- `fixtures/boulder-schemas/`: sample `boulder.json` shapes for registry tests.
- `evals/`: eval tasks and `run-eval.sh` for agent-quality checks (`just eval-consistency`).
- `README.md`: full instructions for running and adding tests in each layer. Read
  that before this file for how-to details.

## Conventions

State-file schemas exercised by these tests live in `.claude/rules/state-schemas.md`.
Hook-authoring conventions live in `.claude/rules/hook-scripts.md`.
