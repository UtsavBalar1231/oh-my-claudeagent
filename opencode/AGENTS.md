# OpenCode V2 adapter

`index.ts` is the server plugin. `tui.tsx` is the optional terminal companion;
`tui-panel.tsx` renders its session panel with native theme and interaction APIs.
`rpc.ts` is its import-safe contract. `state.ts` reads checkout-local OMCA state and
`tasks.ts` writes the task list. `tools.ts` registers native, session-aware tools. `lib.ts` projects shared
Markdown bodies and metadata into native definitions; it owns no second prompt
roster. `workflows.ts` contains OpenCode-specific coordination.

Package installs load `tui.generated.js`, compiled from the same TypeScript UI.
Run `just build-opencode` after UI or RPC changes. Do not edit the artifact by
hand or bundle host packages into it; CI checks its source freshness.

Use the public OpenCode V2 APIs and the installed SDK types. Do not import private
OpenCode services, local credential files, or its SQLite database.

Resolve the current session location for each operation. Keep execution cwd,
checkout-local state, and the plugin installation directory separate. Never
change process cwd or environment to supply per-session context.

The TUI reads server snapshots over RPC. It never reads server paths on the client
machine. Viewing a panel must not change the task list, run a model, or create state files.
Use additive native slots and semantic theme tokens; preserve native navigation.

A run lives in `.omca/state/tasks/<id>.json`, in the file shape Claude Code uses for
its own list, so `src/core/native-tasks.ts` reads both. OpenCode's `todowrite` cannot
carry a run: it is off unless the user sets `experimental.todo`, and a plugin cannot
set it. It replaces the whole list on every call, its items have only `content` and
`status`, and the list exists only in that session's message history. Only the `omca`
agent writes tasks, which the tool refuses from any other agent and the context hook
hides from them. `omca_task_update` holds a run's final task until its verdict is logged.

Native permission checks apply to custom tool filesystem operations too. Plan
mode cannot apply mutations, the task list included. Child agents have their own
permissions, so read-only delegation must be explicit.

OpenCode has no documented Stop veto. Historical evidence, completed tasks,
and current-checkout verification are different states.

Run `just test-opencode` for adapter tests and `just ci` before claiming the change
verified. Integration tests require the supported OpenCode executable on PATH.
