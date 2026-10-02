# Tests

Behavioral and integration tests for the plugin. Bun specs (`*.spec.ts`) live beside the
code they cover, such as `servers/` and `src/`, rather than here; mod tests are in `mod/`.

## Layout

- `bats/hooks/`: the golden replay of `validate-plugin.sh` and the sisyphus contract canary
  (`just test-bats`). `bats/bats-core` is a git submodule; run `git submodule update --init`
  first.
- `bats/unit/`: BATS contract tests for the validator, the workflows and the frontmatter.
- `fixtures/mcp/`: JSON-RPC requests and the golden `expected-tools.json` baseline,
  which `servers/omca.spec.ts` and the validator's MCP check read.
- `fixtures/boulder-schemas/`: sample `boulder.json` shapes for registry tests.
- `evals/`: eval tasks and `run-eval.sh` for agent-quality checks (`just eval-consistency`).
- `README.md`: full instructions for running and adding tests in each layer. Read
  that before this file for how-to details.

## Conventions

The state files these tests exercise are written under `.omca/state/` (and
`.omca/evidence/` for the evidence log). `fixtures/boulder-schemas/` holds the
`boulder.json` shapes, and `src/core/boulder.ts` is the authority on that schema.
