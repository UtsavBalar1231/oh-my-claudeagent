# Hook Inventory

`hooks/hooks.json` is the canonical hook registry — query it directly for counts.

## Hook events

`SessionStart`, `InstructionsLoaded`, `UserPromptSubmit`, `SubagentStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure`, `SubagentStop`, `TaskCreated`, `PreCompact`, `PostCompact`, `SessionEnd`, `Notification`, `TaskCompleted`, `TeammateIdle`, `ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`

## Current runtime contract

- `UserPromptSubmit` routes to `keyword-detector.sh` for ralph, ultrawork, and other activation keywords.
- `permission-filter.sh` is guardrail-only. It does not auto-allow commands.
- `WorktreeCreate` and `WorktreeRemove` are plugin-owned worktree hooks (both route to `lifecycle-state.sh`).
- Hook lifecycle ownership stays Claude-native. OMCA only supplies command handlers.
