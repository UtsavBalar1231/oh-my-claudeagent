# Tests

This directory contains behavioral and integration tests for oh-my-claudeagent.

## Directory Structure

```
tests/
  bats/
    bats-core/      # BATS test framework (git submodule)
    hooks/          # golden replay of validate-plugin.sh, sisyphus contract canary
    unit/           # validator, workflow and frontmatter contract tests
  evals/            # Eval tasks and run scripts
  fixtures/
    mcp/            # JSON-RPC requests and the expected tool list for the MCP server
  mod/              # mod tests, run by `claude plugin test .`
```

Bun specs (`*.spec.ts`) live beside the code they cover, under `src/`, `servers/`,
`statusline/`, `scripts/` and `opencode/`.

## Running Tests Locally

```bash
# All layers at once
just test-all

# Layer 1: structural validation (claims + hooks format)
just test

# Layer 2: BATS contract tests (validator golden replay, workflows, frontmatter)
git submodule update --init   # pull bats-core if not present
just test-bats

# Layer 3: MCP server specs (requires ast-grep)
just test-mcp

# Layer 4: every bun spec
just test-bun
```

## Adding a BATS Test

1. Create `tests/bats/unit/your-test-name.bats` by copying an existing file as a template.
2. Each test function follows the pattern:

```bash
@test "your-area: description of expected behavior" {
```

3. Run `just test-bats` to verify locally before committing.

## Adding a Bun Spec

Put `your-module.spec.ts` beside the module and import from `bun:test`. A spec that spawns a
process passes `env` explicitly, because `Bun.spawn` without `env` does not see runtime
`process.env` changes. Run it with `bun test <path>`.

## CI Integration

CI runs these jobs on every push and pull request to `main`:

| Job | Command |
|-----|---------|
| `validate` | `validate-plugin.sh --check claims --check hooks` |
| `lint-shell` | `shellcheck scripts/*.sh` |
| `test-bats` | `bats tests/bats/hooks/ tests/bats/unit/` (submodules: true) |
| `test-mcp` | `bun test servers` |
| `test-opencode` | the OpenCode adapter suite |
| `typescript` | both tsc projects, the mod tests and the bun specs |
| `validate-manifest` | `claude plugin validate . --strict` |

## Running Hooks Ad-hoc

Hooks are `mcp_tool` entries that call `omca_hook` on the server. To exercise a handler
without a session, send a `tools/call` request for `omca_hook` to `bun servers/omca.ts` from
a scratch directory, since the server roots its `.omca/` state at the git top level of its
working directory.

### Why BATS tests are already safe

BATS tests isolate state automatically. `tests/bats/test_helper.bash` sets `CLAUDE_PROJECT_ROOT` to a per-test temp dir (`$BATS_TEST_TMPDIR/project`) and creates the required subdirectories before each test. No real `.omca/state/` is ever touched during `just test-bats`.
