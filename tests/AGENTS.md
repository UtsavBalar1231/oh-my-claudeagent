# Tests

Behavioral and integration tests for the plugin. Bun specs (`*.spec.ts`) live beside the
code they cover, such as `servers/`, `src/` and `scripts/`, rather than here; mod tests are in
`mod/`.

## Layout

- `fixtures/mcp/`: JSON-RPC requests and the golden `expected-tools.json` baseline,
  which `servers/omca.spec.ts` and the validator's MCP check read.
- `fixtures/boulder-schemas/`: sample `boulder.json` shapes for registry tests.
- `evals/`: eval task definitions for agent-quality checks, listed by `just eval-consistency` (`scripts/qa/eval-tasks.ts`).
- `README.md`: full instructions for running and adding tests in each layer. Read
  that before this file for how-to details.

## Conventions

The state files these tests exercise are written under `.omca/state/` (and
`.omca/evidence/` for the evidence log). `fixtures/boulder-schemas/` holds the
`boulder.json` shapes, and `src/core/boulder.ts` is the authority on that schema.
