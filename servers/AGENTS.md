# Servers

The `omca` MCP server: one bun process over stdio that serves OMCA's tools to the model
(evidence log, notepads, ast-grep search, filesystem helpers, catalogs) and answers the
`omca_hook` calls the settings hooks make. It speaks MCP revisions 2026-07-28 and 2025-11-25 from
the same stdio loop, with no SDK.

## Layout

- `omca.ts`: entry point, launched as `bun servers/omca.ts` from `.mcp.json`. Declares the
  tool list, handles the handshake and `tools/call`, and runs the shutdown handler.
- `jsonrpc.ts`: the line-delimited JSON-RPC dispatcher, with per-request cancellation.
- `progress.ts`: the throttled `notifications/progress` reporter and the context a tool receives.
- `io.ts`: state-directory resolution, the temp-plus-rename writer and the lock protocol.
- `lifecycle.ts`: start-up housekeeping (ledger rotation, record pruning).
- `plugin-root.ts`: the plugin root, `CLAUDE_PLUGIN_ROOT` when it names a directory.
- `tools/`: one module per tool family (`evidence.ts`, `notepad.ts`, `ast.ts`, `filesystem.ts`,
  `sessions.ts`, `catalog.ts`, `tasks.ts`) plus `hook.ts`, the `omca_hook` entry point,
  and `args.ts`, the shared argument readers. Each tool module has its spec beside it.
- `hooks/`: one handler per hook behavior, wired into `registry.ts`. Shared logic lives in
  `src/core/`.
- `categories.json`: model-tier routing table for OMCA agent categories.
- `tests/fixtures/mcp/expected-tools.json`: the tool names the model sees. `omca.spec.ts`
  asserts `tools/list` equals it plus `omca_hook`.

## Conventions

- Agents, skills and user allowlists name each tool as
  `mcp__plugin_oh-my-claudeagent_omca__<tool>`, so a change to a tool name or input schema
  breaks them. `.claude/rules/mcp-server.md` has the declaration contract.
- Only `evidence_log` and `notepad_write` declare
  `_meta["anthropic/alwaysLoad"]: true`, and `.mcp.json` sets no server-level `alwaysLoad`, so
  every other tool waits behind tool search. `OMCA_TOOLS` in `hooks/subagent-context.ts` states
  the loading rule once, for the server instructions and the SubagentStart context.
- Run the specs with `bun test servers`, and the handshake check with `just validate --check mcp`; `just typecheck` covers this
  directory through `tsconfig.runtime.json`.
- Keep a tool description under 2,048 characters, a margin OMCA keeps under Claude Code's cap; a longer one is truncated.

The state files these tools read and write are `verification-evidence.json` (the append-only
evidence log, `command` and `output_snippet` capped at 2000 characters, `verified_by` and `task_id`
at 200) and the notepad tree under `.omca/notepads/`, keyed
by `plan_name`, which holds the run's name.

A run lives on Claude Code's own task list, at `<config dir>/tasks/<list id>/<id>.json`, and no OMCA
code writes those files. The mod writes the list's id into its marker as `task_list`, and
`readTasks` in `hooks/status-file.ts` resolves it from there, falling back to the session id. A
planned task has `metadata.run`; the last task of a run has `metadata.final: true` and is blocked by
every other task; `metadata.blocked: "<why>"` closes a task without completing it. Two handlers
enforce a run:

- `stop-gates`' `task-continuation` gate continues a turn while the run has open tasks, only for a
  session that `task-touch` saw use `TaskCreate` or `TaskUpdate`. That flag is in memory, so `/clear`
  starts a session that must touch a task to pick the run up.
- `task-completed` blocks the final task until the ledger holds a passing `final_verification`
  whose `task_id` is that task's. `OMCA_DISABLED_HOOKS=final-verification` turns off this check alone.

`readLedger` in `src/core/evidence.ts` is the ledger's one reader. It refuses text that is not JSON,
not an object, or whose `version` key is present and not `1`; a file without `version` reads as
version 1. Writers (`evidence_log`, ledger rotation and its archives) stamp `"version": 1` as the
first key and throw an error naming the file when the reader refuses it, so a corrupt ledger is
never replaced. The reader returns the well-formed entries and skips the others, so one malformed
entry does not hide the rest.

The OpenCode adapter starts no server. It registers the same evidence, notepad, AST and file tools
natively from `opencode/tools.ts` and keeps a run in its own task files.
