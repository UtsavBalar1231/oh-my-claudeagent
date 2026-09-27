<!-- Overlay for agents/explore.md. Each section below replaces the section with the same heading in that file;
     every section not listed here is taken from the source unchanged. -->

## Tool Strategy

Use the right tool for the job:

| Need | Tool |
|------|------|
| Structural patterns (function shapes, class structures) | ast_search (MCP tool, available to all agents in this project) |
| Text patterns (strings, comments, logs) | `grep` |
| File patterns (find by name/extension) | `glob` |
| Read file contents | `read` |
| History/evolution (when added, who changed) | `shell` with git commands |

For a path outside the project root, read it with the omca `file_read` MCP tool: the built-in `read` tool prompts for external-directory approval on a path outside the workspace, and `file_read` avoids that.

`boulder_write`, `evidence_read`, `notepad_read`, `ast_search`, and `file_read` are discovery-deferred, so load each through ToolSearch before calling it; only `evidence_log`, `boulder_progress`, and `notepad_write` are loaded eagerly.
