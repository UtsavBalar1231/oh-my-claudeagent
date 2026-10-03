# Tests

This directory contains behavioral and integration tests for oh-my-claudeagent.

## Directory Structure

```
tests/
  evals/            # Eval task definitions, listed by `just eval-consistency`
  plugin-evals/     # `claude plugin eval` cases for the planning skills; see its README
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

# Layer 1: structural validation (claims, hooks, mod, tree and engine checks)
just test

# Layer 2: MCP server specs and the handshake check (requires ast-grep)
just test-mcp

# Layer 3: every bun spec, including the validator specs and the workflow contract
just test-bun

# The OpenCode adapter: typecheck and every opencode/ spec (needs opencode on PATH)
just test-opencode
```

## Adding a Bun Spec

Put `your-module.spec.ts` beside the module and import from `bun:test`. A spec that spawns a
process passes `env` explicitly, because `Bun.spawn` without `env` does not see runtime
`process.env` changes. Run it with `bun test <path>`.

A spec that drives the `opencode` binary also passes `stdin: "ignore"`, because `opencode run`
reads a piped stdin to EOF and hangs when the caller's stdin is an open pipe, and sets `PWD`
beside `cwd`, because it resolves its directory from `PWD`. It runs OpenCode against a private
copy of the plugin: OpenCode reloads a plugin when any file under the plugin's `opencode/`
directory or its imported sources changes.

## CI Integration

CI runs these jobs on every push and pull request to `main`:

| Job | Command |
|-----|---------|
| `validate` | `bun scripts/validate.ts --check claims --check hooks --check mod --check tree --check engine` |
| `test-mcp` | `bun test servers` and `bun scripts/validate.ts --check mcp` |
| `test-opencode` | the OpenCode adapter: typecheck, then `bun test opencode/`, whose smoke and model-path specs run against a real OpenCode install |
| `typescript` | both tsc projects, the mod tests and the bun specs |
| `validate-manifest` | `claude plugin validate . --strict` |

## Running Hooks Ad-hoc

Hooks are `mcp_tool` entries that call `omca_hook` on the server. To exercise a handler
without a session, send a `tools/call` request for `omca_hook` to `bun servers/omca.ts` from
a scratch directory, since the server roots its `.omca/` state at the git top level of its
working directory.
