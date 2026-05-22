#!/usr/bin/env bats
# Behavioral tests for executor-grep-deny.sh — deny Grep/Bash-grep on code files
# when the active subagent is oh-my-claudeagent:executor.

load '../test_helper'

EXECUTOR_STATE='{"active":[{"id":"agent-x","type":"oh-my-claudeagent:executor","model":"sonnet","promptPreview":"","startedAt":"2026-01-01T00:00:00Z","status":"running","started_epoch":1000}],"completed":[]}'

# Seed subagents.json with an executor entry before each test.
setup_executor_state() {
	write_state "subagents.json" "$EXECUTOR_STATE"
}

# ── Grep on code file: executor denied ────────────────────────────────────────

@test "Grep *.py by executor agent-x is denied (exit 2)" {
	setup_executor_state
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","agent_id":"agent-x","tool_input":{"pattern":"foo","glob":"*.py"}}'
	assert_failure 2
}

@test "Grep denial stderr message references ast_search" {
	setup_executor_state
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","agent_id":"agent-x","tool_input":{"pattern":"foo","glob":"*.py"}}'
	assert_failure 2
	assert_output --partial 'ast_search'
}

@test "Grep *.ts by executor is denied" {
	setup_executor_state
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","agent_id":"agent-x","tool_input":{"pattern":"foo","glob":"*.ts"}}'
	assert_failure 2
}

@test "Grep *.md by executor is denied" {
	setup_executor_state
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","agent_id":"agent-x","tool_input":{"pattern":"foo","glob":"*.md"}}'
	assert_failure 2
}

# ── Grep on allowed extension: executor passes ────────────────────────────────

@test "Grep *.json by executor is allowed (exit 0)" {
	setup_executor_state
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","agent_id":"agent-x","tool_input":{"pattern":"foo","glob":"*.json"}}'
	assert_success
}

@test "Grep *.yaml by executor is allowed" {
	setup_executor_state
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","agent_id":"agent-x","tool_input":{"pattern":"foo","glob":"*.yaml"}}'
	assert_success
}

@test "Grep *.toml by executor is allowed" {
	setup_executor_state
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","agent_id":"agent-x","tool_input":{"pattern":"foo","glob":"*.toml"}}'
	assert_success
}

# ── Non-executor agent: always allowed ────────────────────────────────────────

@test "Grep *.py by unknown agent-y (not in state) is allowed" {
	setup_executor_state
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","agent_id":"agent-y","tool_input":{"pattern":"foo","glob":"*.py"}}'
	assert_success
}

@test "Grep *.py with explicit subagent_type=oh-my-claudeagent:explore is allowed" {
	setup_executor_state
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","subagent_type":"oh-my-claudeagent:explore","tool_input":{"pattern":"foo","glob":"*.py"}}'
	assert_success
}

@test "Grep *.py with no agent_id (main session) is allowed" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","tool_input":{"pattern":"foo","glob":"*.py"}}'
	assert_success
}

# ── Bash grep on code file: executor denied ───────────────────────────────────

@test "Bash grep on .py file by executor is denied (exit 2)" {
	setup_executor_state
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","agent_id":"agent-x","tool_input":{"command":"grep foo src/main.py"}}'
	assert_failure 2
}

@test "Bash grep on .ts file by executor is denied" {
	setup_executor_state
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","agent_id":"agent-x","tool_input":{"command":"grep -r pattern src/index.ts"}}'
	assert_failure 2
}

# ── Bash grep on allowed extension: executor passes ──────────────────────────

@test "Bash grep on .json file by executor is allowed" {
	setup_executor_state
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","agent_id":"agent-x","tool_input":{"command":"grep foo data.json"}}'
	assert_success
}

@test "Bash grep on .log file by executor is allowed" {
	setup_executor_state
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","agent_id":"agent-x","tool_input":{"command":"grep ERROR app.log"}}'
	assert_success
}

# ── Bash non-grep command: always passes ─────────────────────────────────────

@test "Bash non-grep command by executor is allowed" {
	setup_executor_state
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","agent_id":"agent-x","tool_input":{"command":"ls src/"}}'
	assert_success
}

# ── Other tools: always passes ────────────────────────────────────────────────

@test "Read tool event is always allowed (not Grep or Bash)" {
	setup_executor_state
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Read","agent_id":"agent-x","tool_input":{"file_path":"src/main.py"}}'
	assert_success
}
