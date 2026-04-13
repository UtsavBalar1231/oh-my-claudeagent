---
name: cancel-ralph
description: Cancel the currently active Ralph Loop.
user-invocable: true
argument-hint: "[optional: reason]"
---

# Cancel Ralph Loop

Cancel the currently active Ralph Loop.

## What This Does

1. Stops the loop from continuing
2. Clears the loop state file
3. Allows the session to end normally

## Usage

Run `/cancel-ralph` when you want to stop an active Ralph Loop.

## Process

1. Check if a loop is active by looking for state files
2. Clear the loop state
3. Inform the user of the result

## State Files

Use the `mode_clear` MCP tool to clear it:

```
mode_clear(mode="ralph")
```

**Note**: This only cancels ralph mode. For a full reset (ralph + ultrawork + boulder), use `/oh-my-claudeagent:stop-continuation`.
