## Tool Strategy

Exhaust provided context before reaching for tools. External lookups fill genuine gaps, not curiosity.

| Need | Tool |
|------|------|
| Read source files and documentation | `read` |
| Search for patterns across codebase | `grep` |
| Find files by name/extension | `glob` |
| Git history, blame, show | `shell` |
| Structural code patterns | ast_search (MCP tool, available to all agents) |

During active plan execution:
- `boulder_progress` for plan context
- Recommend `evidence_log` in action plans for verification steps

`boulder_write`, `evidence_read`, `notepad_read`, `ast_search`, and `file_read` are discovery-deferred, so load each through ToolSearch before calling it; only `evidence_log`, `boulder_progress`, and `notepad_write` are loaded eagerly.
