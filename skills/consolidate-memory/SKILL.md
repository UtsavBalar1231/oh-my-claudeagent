---
name: consolidate-memory
description: Consolidate agent project memories and notepad learnings into a unified summary
---

# Consolidate Memory

Consolidate knowledge from the current session into persistent memory.

## What to do

1. Read all notepad sections for the active plan: `notepad_read(plan_name)`
2. Read agent project memories if accessible: `~/.claude/agent-memory/*/MEMORY.md`
3. Identify key learnings, patterns, and decisions worth preserving
4. Update the project MEMORY.md with concise, deduplicated entries
5. Note what was consolidated and what was too session-specific to keep

## Guidelines

- Only persist stable patterns confirmed across multiple interactions
- Remove session-specific context (in-progress tasks, temporary state)
- Organize semantically by topic, not chronologically
- MEMORY.md is loaded into every session — first 200 lines or 25KB, whichever comes first. Consolidate when approaching either limit.
