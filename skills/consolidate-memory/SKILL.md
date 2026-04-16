---
name: consolidate-memory
description: Consolidate agent project memories and notepad learnings into a unified summary
---

# Consolidate Memory

Consolidate session knowledge into persistent memory.

## Steps

1. `notepad_read(plan_name)` — all sections for active plan
2. Read `~/.claude/agent-memory/*/MEMORY.md` if accessible
3. Identify learnings, patterns, decisions worth preserving
4. Update project MEMORY.md — concise, deduplicated
5. Note what was kept vs too session-specific

## Guidelines

- Only persist patterns confirmed across multiple interactions
- Remove session-specific context (in-progress tasks, temporary state)
- Organize by topic, not chronologically
- MEMORY.md loads first 200 lines or 25KB per session. Consolidate when approaching limits.
