# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-15

Initial public release of oh-my-claudeagent — a markdown-first Claude Code plugin
for multi-agent orchestration.

### Added

- 11 specialist agents (Greek mythology names): sisyphus, atlas, prometheus, metis,
  momus, oracle, sisyphus-junior, explore, librarian, hephaestus, multimodal-looker
- 18 skills including ralph persistence, ultrawork parallel execution, handoff,
  git-master, frontend-ui-ux, and agent command skills (atlas, metis, prometheus-plan,
  hephaestus, sisyphus-orchestrate)
- ast-grep MCP server wrapping `sg` CLI for structural code search and transformation
- omca-state MCP server with boulder (work plan tracking), evidence (verification),
  and notepad (subagent learning) management
- 17 hook event types across 25 hook commands covering session lifecycle, tool
  lifecycle, agent lifecycle, and infrastructure events
- PostCompact log hook for compaction observability
- Keyword detection system with auto-activation of skills and modes
- Ralph persistence loop — blocks session stop until verified complete
- Context injection on file read (AGENTS.md, README.md, .omca/rules/)
- Compaction survival pipeline (PreCompact save → PostCompact enrich → SessionStart re-inject)
- Agent tracking pipeline across PreToolUse → SubagentStart → SubagentStop
- Permission auto-approval for package managers, denial for destructive `rm -rf`
- Notepad injection and plan-file protection in SubagentStart hook
- Plugin validation harness and contract test fixtures
- GitHub Actions CI and release workflows
- Dependabot configuration for automated dependency updates
- Project quality tooling (EditorConfig, ruff, shellcheck)

### Fixed

- Stop hook output format and `hookEventName` field name mismatch
- Boulder field name (`.planFile` → `.active_plan`) in subagent-start and pre-compact hooks
- Marketplace source path in schema definition
- ast-grep bootstrap diagnostics and error reporting
- Hook permission handling and lifecycle edge cases
- LSP capability provenance clarified as host-provided in agent definitions
- Skill setup, provenance checks, and capability boundary enforcement
- Executable permissions on all hook and utility scripts
- Orphaned keyword removal, safe fallback defaults, and JSON escaping
- Single-read pattern, consistent `jq` arguments, and UTF-8 safe truncation
- Delegation reminder suppression inside subagent contexts
- Context injection rules extended to Write and Edit events (not just Read)
- `CLAUDE_PLUGIN_ROOT` fallback for MCP server commands

### Changed

- README and runtime template rewritten for public release
- Dead worktree scripts removed; utility launchers documented
- Shellcheck fixes applied across all hook scripts
- Ruff fixes applied to Python MCP servers

[1.0.0]: https://github.com/UtsavBalar1231/oh-my-claudeagent/releases/tag/v1.0.0
