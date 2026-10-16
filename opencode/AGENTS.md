# OpenCode V2 adapter

`index.ts` is the server plugin. `tui.tsx` is the optional terminal companion;
`tui-panel.tsx` renders its session panel with native theme and interaction APIs.
`rpc.ts` is its import-safe contract. `state.ts` reads checkout-local OMCA state.
`tools.ts` registers native, session-aware tools. `lib.ts` projects shared
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
machine. Viewing a panel must not bind a plan, run a model, or create state files.
Use additive native slots and semantic theme tokens; preserve native navigation.

Native permission checks apply to custom tool filesystem operations too. Plan
mode cannot bind execution or apply mutations. Child agents have their own
permissions, so read-only delegation must be explicit.

OpenCode has no documented Stop veto. Historical evidence, completed task boxes,
and current-checkout verification are different states.

Run `just test-opencode` for adapter tests and `just ci` before claiming the change
verified. Integration tests require the supported OpenCode executable on PATH.
