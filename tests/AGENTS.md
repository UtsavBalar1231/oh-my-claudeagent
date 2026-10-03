# Tests

Behavioral and integration tests for the plugin. Bun specs (`*.spec.ts`) live beside the
code they cover, such as `servers/`, `src/` and `scripts/`, rather than here; mod tests are in
`mod/`.

## Layout

- `fixtures/mcp/`: JSON-RPC requests and the golden `expected-tools.json` baseline,
  which `servers/omca.spec.ts` and the validator's MCP check read.
- `fixtures/boulder-schemas/`: sample `boulder.json` shapes for registry tests.
- `fixtures/plans/`, `fixtures/settings/` and `fixtures/statusline/`: a long plan file for the
  plan reader spec, the settings files status line setup reads, and the recorded payload and
  output cases of the status line.
- `fixtures/spec-env.ts` and `fixtures/fake-exec.ts`: helpers for specs that spawn a process,
  one for the environment to pass and one for a fake executable that works on Windows.
- `mod/`: the mod tests, run by `claude plugin test .`. `mod/visual/` holds the view definitions
  and the recorded captures behind `just visual <view>`.
- `evals/`: eval task definitions for agent-quality checks, listed by `bun scripts/qa/eval-tasks.ts`
  (`scripts/qa/eval-tasks.ts`).
- `plugin-evals/`: `claude plugin eval` cases for the planning skills' health gate. They call a
  real model, so they run by hand. `plugin-evals/README.md` has the commands.
- `README.md`: how to run and add tests in each layer. Read it before this file for how-to
  details.

## Conventions

The state files these tests exercise are written under `.omca/state/` (and
`.omca/evidence/` for the evidence log). `fixtures/boulder-schemas/` holds the
`boulder.json` shapes, and `src/core/boulder.ts` is the authority on that schema.
