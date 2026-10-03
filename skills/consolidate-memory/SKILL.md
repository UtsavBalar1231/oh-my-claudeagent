---
name: consolidate-memory
description: Use when a plan finishes or agent memories have piled up. Merges agent project memories and notepad learnings into the project's auto-memory index.
---

# Consolidate memory

Consolidate session knowledge into persistent memory.

## Steps

1. `notepad_read(plan_name)`: all sections for active plan; load it if needed: `ToolSearch({query: "select:mcp__plugin_oh-my-claudeagent_omca__notepad_read", max_results: 1})`
2. Read agent memory files at both scopes if accessible:
   - user scope: `~/.claude/agent-memory/*/MEMORY.md`
   - project scope: `.claude/agent-memory/*/MEMORY.md` (platform writes project memories here, resolving from the project root)
3. Identify learnings, patterns, decisions worth preserving
4. Update the project's auto-memory index, `~/.claude/projects/<project>/memory/MEMORY.md` (or `MEMORY.md` under the `autoMemoryDirectory` setting when set): concise, deduplicated
5. Note what was kept vs too session-specific

## Guidelines

- Only persist patterns confirmed across multiple interactions
- Remove session-specific context (in-progress tasks, temporary state)
- Organize by topic, not chronologically
- MEMORY.md loads first 200 lines or 25KB per session. Consolidate when approaching limits.
