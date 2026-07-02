# Template Inventory

`templates/claudemd.md` is the canonical source for the user-scope orchestration
block. The omca-setup skill reads it at install time and injects it into
`~/.claude/CLAUDE.md`. Editing it changes what future setup runs install; users
refresh by re-running /oh-my-claudeagent:omca-setup.

The always-on per-turn discipline lives separately in `output-styles/omca-default.md`
as a first-class platform output style; the template carries the operational
guidance (entrypoints, agent catalog, workflow, cross-cutting policy).
