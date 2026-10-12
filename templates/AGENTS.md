# Template inventory

`templates/claudemd.md` is the orchestration guidance OMCA's server delivers. The server's
guidance handler (`servers/hooks/guidance.ts`) reads it once per server process from
`CLAUDE_PLUGIN_ROOT` and adds it, with a `Session <session_id>` line, to the first prompt of
each session; the `SessionStart` handler for `compact` adds it again after compaction. Nothing
writes it into `~/.claude/CLAUDE.md`.

Editing the template changes what every session receives on its next server start. Keep the
text free of anything that varies per session, so the first request's prompt cache stays warm.

The always-on per-turn discipline lives separately in `output-styles/omca-default.md` as a
platform output style; the template carries the operational guidance (entrypoints, agent
catalog, workflow, cross-cutting policy).
