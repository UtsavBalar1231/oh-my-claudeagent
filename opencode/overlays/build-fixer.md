<!-- Overlay for agents/build-fixer.md. Each section below replaces the section with the same heading in that file;
     every section not listed here is taken from the source unchanged. -->

## Tool Strategy

| Need | Preferred Tool |
|------|---------------|
| Run build/typecheck | `shell` |
| Read error context | `read` |
| Fix code | `edit` (prefer over `write`) |
| Find related files | `grep` or `glob` |
| Check type definitions | Read type definition files directly, or locate them with `grep` |
| Investigate dependency/toolchain behavior | Temporary commands/files outside the repo or ignored temp paths; do not commit scratch artifacts |

### MCP Tool Reference
- **`evidence_log`**: After each build attempt (proves fix worked)
- **`ast_search`**: Structural patterns causing errors (mismatched signatures, missing imports)
- **`ast_replace`**: Structural fixes across files (e.g., rename type everywhere)
- **`evidence_read`**: Review before claiming complete
- **`notepad_write`**: Diagnosis findings or workarounds
