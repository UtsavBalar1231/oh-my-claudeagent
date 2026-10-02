<!-- Overlay for agents/oracle.md. Each section below replaces the section with the same heading in that file;
     every section not listed here is taken from the source unchanged. -->

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
