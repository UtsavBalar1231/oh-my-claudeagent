# Servers

The `omca` MCP server: one bun process over stdio that serves OMCA's tools to the model
(boulder plan registry, evidence log, notepads, ast-grep search, filesystem helpers,
catalogs) and answers the `omca_hook` calls the settings hooks make. It speaks MCP spec
revision 2026-07-28 and every 2025-era client from the same stdio loop, with no SDK.

## Layout

- `omca.ts`: entry point, launched as `bun servers/omca.ts` from `.mcp.json`. Declares the
  tool list, handles the handshake and `tools/call`, and runs the shutdown handler.
- `jsonrpc.ts`: the line-delimited JSON-RPC dispatcher, with per-request cancellation.
- `progress.ts`: the throttled `notifications/progress` reporter and the context a tool receives.
- `io.ts`: state-directory resolution, the temp-plus-rename writer and the lock protocol.
- `lifecycle.ts`: start-up housekeeping (registry GC, ledger rotation, record pruning).
- `tools/`: one module per tool family (`boulder.ts`, `evidence.ts`, `notepad.ts`, `ast.ts`,
  `filesystem.ts`, `sessions.ts`, `catalog.ts`) plus `hook.ts`, the `omca_hook` entry point.
  Each module has its spec beside it.
- `hooks/`: one handler per hook behavior, wired into `registry.ts`. Shared logic lives in
  `src/core/`.
- `categories.json`: model-tier routing table for OMCA agent categories.
- `tests/fixtures/mcp/expected-tools.json`: the tool names the model sees. `omca.spec.ts`
  asserts `tools/list` equals it plus `omca_hook`.

## Conventions

- The tool contract is language-neutral: tool names and input schemas are named by agents,
  skills and user allowlists as `mcp__plugin_oh-my-claudeagent_omca__<tool>`, so changing
  one is a breaking change. `.claude/rules/mcp-server.md` has the declaration contract.
- Run the specs with `just test-mcp` (`bun test servers`); `just typecheck-ts` covers this
  directory through `tsconfig.runtime.json`.
- Keep a tool description under 2,048 characters; Claude Code truncates past that.

The state files these tools read and write are `boulder.json` (a session-bound plan
registry keyed `plans[plan_name]` and `bindings[session_id]`),
`verification-evidence.json` (the append-only evidence log, `command` and `output_snippet`
capped at 2000 characters, `verified_by` at 200, `plan_sha256` 64 hex characters or empty), and
the notepad tree under `.omca/notepads/`. Read `resolveBoundPlan` in
`src/core/boulder.ts` for the resolution ladder rather than hand-parsing `boulder.json`
anywhere else.
