---
name: cancel-ralph
description: Cancel the currently active Ralph Loop.
user-invocable: true
argument-hint: "[optional: reason]"
---

# Cancel Ralph Loop

Stop the active Ralph Loop.

## What It Does

1. Stop loop continuation
2. Clear loop state file
3. Allow session to end normally

## Process

1. Check for active state files
2. Clear via `mode_clear(mode="ralph")`
3. Report result

**Note**: Cancels ralph only. Full reset (ralph + ultrawork + boulder) → `/oh-my-claudeagent:stop-continuation`.
