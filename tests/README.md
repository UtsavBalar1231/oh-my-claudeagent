# Tests

Behavioral and integration tests for oh-my-claudeagent.

## Directory structure

```
tests/
  evals/             # Eval tasks, listed by `bun scripts/qa/eval-tasks.ts`, and their trial records
  plugin-evals/      # `claude plugin eval` cases for the planning skills; see its README
  fixtures/
    mcp/             # JSON-RPC requests and the expected tool list for the MCP server
    boulder-schemas/ # sample boulder.json shapes for registry tests
    plans/           # a long plan file for the plan reader spec
    settings/        # the settings files status line setup reads
    statusline/      # recorded payloads and rendered output for the status line
    spec-env.ts      # the environment a spec passes to a process it spawns
    fake-exec.ts     # a fake executable that runs on Windows too
    canonical-tmp.ts # bunfig.toml preload: the long form of TEMP on Windows
    plain-output.ts  # bunfig.toml preload: drops FORCE_COLOR
  mod/               # mod tests, run by `claude plugin test .`
    visual/          # view definitions and recorded captures behind `just visual <view>`
```

Bun specs (`*.spec.ts`) live beside the code they cover. `just test` runs the ones under `src/`,
`servers/`, `statusline/`, `scripts/` and `benchmarks/compare/`, and `just test-opencode` runs
the ones under `opencode/`.

## Running tests locally

```bash
# Everything CI runs
just ci

# Every validator group: claims, hooks, mod, tree, engine and mcp
just validate

# One group, for example the MCP handshake check
just validate --check mcp

# Every bun spec outside opencode/, including the validator specs and the workflow contract
just test

# The mod tests (needs the claude CLI)
just test-mod

# Every opencode/ spec; the ones that load OpenCode skip without opencode on PATH
just test-opencode

# One claude -p session with the packaged plugin against the mock model (needs the claude CLI)
just smoke
```

## Adding a bun spec

Put `your-module.spec.ts` beside the module and import from `bun:test`. A spec that spawns a
process passes `env` explicitly, because `Bun.spawn` without `env` does not see runtime
`process.env` changes. Run it with `bun test <path>`.

A spec that drives the `opencode` binary also passes `stdin: "ignore"`, because `opencode run`
reads a piped stdin to EOF and hangs when the caller's stdin is an open pipe, and sets `PWD`
beside `cwd`, because it resolves its directory from `PWD`. It runs OpenCode against a private
copy of the plugin: OpenCode reloads a plugin when any file under the plugin's `opencode/`
directory or its imported sources changes.

## CI jobs

CI runs these jobs on a push to `main`, on every pull request and on demand. Every job except
`validate-manifest` runs on Linux, macOS and Windows:

| Job | Command |
|-----|---------|
| `validate` | `bun scripts/validate.ts`, every validator group including the MCP handshake (the engine group skips without the claude CLI) |
| `test-opencode` | `bun test opencode/`, whose smoke and model-path specs run against a real OpenCode install |
| `typescript` | oxlint with warnings denied, the three tsc projects (the mod, the bun runtime and the OpenCode adapter), the mod tests, the bun specs with a JUnit report that `scripts/qa/junit-complete.ts` checks for failures and for every spec file, a seeded random-order run on Linux, and the engine checks, which validate a packaged copy under `--strict` |
| `smoke` | `bun scripts/qa/ci-smoke.ts`: a real `claude -p` session with the packaged plugin loaded, against the mock model |
| `validate-manifest` | `claude plugin validate . --strict` and `claude plugin validate .claude-plugin/plugin.json --strict` on the latest published client |

## Running hooks ad hoc

Hooks are `mcp_tool` entries that call `omca_hook` on the server. To exercise a handler
without a session, send a `tools/call` request for `omca_hook` to `bun servers/omca.ts` from
a scratch directory, since the server roots its `.omca/` state at the git top level of its
working directory.
