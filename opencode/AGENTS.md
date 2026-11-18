# OpenCode V2 adapter

`index.ts` is the server plugin. `tui.tsx` is the optional terminal companion;
`tui-panel.tsx` renders its session panel with native theme and interaction APIs.
`rpc.ts` is its import-safe contract. `state.ts` reads checkout-local OMCA state and
`tasks.ts` writes the task list. `tools.ts` registers native, session-aware tools. `spacing.ts`
finds words run together in a delegation prompt with `words.txt`, a SCOWL word list whose header
carries its copyright notice; `guard.ts` refuses the `subagent` call on it. `lib.ts` projects shared
Markdown bodies and metadata into native definitions; it owns no second prompt
roster. `workflows.ts` contains OpenCode-specific coordination. `continuation.ts` keeps the
coordinator working a run when its session would go idle.

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
permissions, so read-only delegation must be explicit. Permission rules from the user's
config and the session come after an agent's own and win, so the specialists' contract is
also held in `execute.before`, which sees every call, Code Mode's inner calls included:
read-only agents never edit, run a shell or use the `opencode_*` tools in `HOST_MUTATORS`;
specialists never delegate; `omca` never delegates to `general` or `explore`. Specialists
cannot call `question`, as OpenCode's own subagents cannot; they report blocking questions
to the coordinator.

An agent's declared effort is applied per request in `experimental.model.resolve`, and only
when its tier model lists that variant: an unknown variant fails the request, and the host
resolves an unchosen variant as `"default"`.

OpenCode has no Stop veto. Its `experimental.idle` session hook runs before a session goes
idle, and a `session.synthetic` message admitted there runs in the same execution. A session
takes a run on when it creates a task or starts or completes one; while that run has open
tasks, `continuation.ts` admits a continuation for the session if it is a top-level `omca`
session with none of its own subagent, image or script work, or test, build or lint command,
running in the background. Other background shells do not hold it, since a dev server never
ends. It holds on a pause request in the last user message, and stops after 3 continuations in
a row get no tool call or 10 pass with no task changing, until the next user message. The
`prompt` hook records each user message too, because compaction can fold it out of the
context the idle hook reads. Each session's record is kept in `ctx.storage` under
`continuation/<sessionID>` and loaded on first use, so a plugin reload or restart, or the
host evicting an idle location, keeps it. A hook that rejects fails the session, so each hook
catches every error.
`OMCA_DISABLED_HOOKS=task-continuation` (or `stop-gates`) turns it off.

`checks.ts` holds each session's last test, build or lint run, recorded from the `shell`
result in `execute.after` and cleared by that session's `omca_evidence_log`; `omca_task_update`
refuses a completion while it is unlogged, as Claude Code's `task-completed` gate does. The
record is in memory, so a reload clears it and the check fails open. The `context` hook gives
each `omca-*` worker the open run's name once per session, with the notepad call for workers
that can write and a report-it line for the read-only ones.

Historical evidence, completed tasks, and current-checkout verification are different states.

Run `just test-opencode` for adapter tests and `just ci` before claiming the change
verified. Integration tests require the supported OpenCode executable on PATH.
