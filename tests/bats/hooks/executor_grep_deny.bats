#!/usr/bin/env bats
# Behavioral tests for executor-grep-deny.sh — deny Grep/Bash-grep on code files
# when the active subagent is oh-my-claudeagent:executor.
# Resolution uses the native .subagent_type payload field exclusively.

load '../test_helper'

# ── Grep on code file: executor denied (via subagent_type) ───────────────────

@test "Grep *.py with subagent_type=executor is denied (exit 2)" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","subagent_type":"oh-my-claudeagent:executor","tool_input":{"pattern":"foo","glob":"*.py"}}'
	assert_failure 2
}

@test "Grep denial stderr message references ast_search" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","subagent_type":"oh-my-claudeagent:executor","tool_input":{"pattern":"foo","glob":"*.py"}}'
	assert_failure 2
	assert_output --partial 'ast_search'
}

@test "Grep *.ts with subagent_type=executor is denied" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","subagent_type":"oh-my-claudeagent:executor","tool_input":{"pattern":"foo","glob":"*.ts"}}'
	assert_failure 2
}

@test "Grep *.md with subagent_type=executor is denied" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","subagent_type":"oh-my-claudeagent:executor","tool_input":{"pattern":"foo","glob":"*.md"}}'
	assert_failure 2
}

# ── Grep on allowed extension: executor passes ────────────────────────────────

@test "Grep *.json with subagent_type=executor is allowed (exit 0)" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","subagent_type":"oh-my-claudeagent:executor","tool_input":{"pattern":"foo","glob":"*.json"}}'
	assert_success
}

@test "Grep *.yaml with subagent_type=executor is allowed" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","subagent_type":"oh-my-claudeagent:executor","tool_input":{"pattern":"foo","glob":"*.yaml"}}'
	assert_success
}

@test "Grep *.toml with subagent_type=executor is allowed" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","subagent_type":"oh-my-claudeagent:executor","tool_input":{"pattern":"foo","glob":"*.toml"}}'
	assert_success
}

# ── Non-executor agent: always allowed ────────────────────────────────────────

@test "Grep *.py with explicit subagent_type=oh-my-claudeagent:explore is allowed" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","subagent_type":"oh-my-claudeagent:explore","tool_input":{"pattern":"foo","glob":"*.py"}}'
	assert_success
}

@test "Grep *.py with no subagent_type (main session) is allowed" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","tool_input":{"pattern":"foo","glob":"*.py"}}'
	assert_success
}

# ── Bash grep on code file: executor denied ───────────────────────────────────

@test "Bash grep on .py file with subagent_type=executor is denied (exit 2)" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","subagent_type":"oh-my-claudeagent:executor","tool_input":{"command":"grep foo src/main.py"}}'
	assert_failure 2
}

@test "Bash grep on .ts file with subagent_type=executor is denied" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","subagent_type":"oh-my-claudeagent:executor","tool_input":{"command":"grep -r pattern src/index.ts"}}'
	assert_failure 2
}

# ── Bash grep on allowed extension: executor passes ──────────────────────────

@test "Bash grep on .json file with subagent_type=executor is allowed" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","subagent_type":"oh-my-claudeagent:executor","tool_input":{"command":"grep foo data.json"}}'
	assert_success
}

@test "Bash grep on .log file with subagent_type=executor is allowed" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","subagent_type":"oh-my-claudeagent:executor","tool_input":{"command":"grep ERROR app.log"}}'
	assert_success
}

# ── Bash non-grep command: always passes ─────────────────────────────────────

@test "Bash non-grep command with subagent_type=executor is allowed" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","subagent_type":"oh-my-claudeagent:executor","tool_input":{"command":"ls src/"}}'
	assert_success
}

# ── Other tools: always passes ────────────────────────────────────────────────

@test "Read tool event is always allowed (not Grep or Bash)" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Read","subagent_type":"oh-my-claudeagent:executor","tool_input":{"file_path":"src/main.py"}}'
	assert_success
}
