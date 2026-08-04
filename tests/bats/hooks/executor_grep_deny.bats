#!/usr/bin/env bats
# Behavioral tests for executor-grep-deny.sh — deny Grep/Bash-grep on code files
# when the active subagent is oh-my-claudeagent:executor.
# Subagent detection uses .agent_id (presence); .agent_type selects the executor branch.

load '../test_helper'

# ── Grep on code file: executor denied (via agent_id + agent_type) ───────────────────

@test "Grep *.py with agent_type=executor is denied (exit 2)" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","agent_id":"agt_exec01","agent_type":"oh-my-claudeagent:executor","tool_input":{"pattern":"foo","glob":"*.py"}}'
	assert_failure 2
}

@test "Grep denial stderr message references ast_search" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","agent_id":"agt_exec01","agent_type":"oh-my-claudeagent:executor","tool_input":{"pattern":"foo","glob":"*.py"}}'
	assert_failure 2
	assert_output --partial 'ast_search'
}

@test "Grep *.ts with agent_type=executor is denied" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","agent_id":"agt_exec01","agent_type":"oh-my-claudeagent:executor","tool_input":{"pattern":"foo","glob":"*.ts"}}'
	assert_failure 2
}

@test "Grep *.md with agent_type=executor is denied" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","agent_id":"agt_exec01","agent_type":"oh-my-claudeagent:executor","tool_input":{"pattern":"foo","glob":"*.md"}}'
	assert_failure 2
}

# ── Grep on allowed extension: executor passes ────────────────────────────────

@test "Grep *.json with agent_type=executor is allowed (exit 0)" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","agent_id":"agt_exec01","agent_type":"oh-my-claudeagent:executor","tool_input":{"pattern":"foo","glob":"*.json"}}'
	assert_success
}

@test "Grep *.yaml with agent_type=executor is allowed" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","agent_id":"agt_exec01","agent_type":"oh-my-claudeagent:executor","tool_input":{"pattern":"foo","glob":"*.yaml"}}'
	assert_success
}

@test "Grep *.toml with agent_type=executor is allowed" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","agent_id":"agt_exec01","agent_type":"oh-my-claudeagent:executor","tool_input":{"pattern":"foo","glob":"*.toml"}}'
	assert_success
}

# ── Non-executor agent: always allowed ────────────────────────────────────────

@test "Grep *.py with explicit agent_type=oh-my-claudeagent:explore is allowed" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","agent_id":"agt_expl01","agent_type":"oh-my-claudeagent:explore","tool_input":{"pattern":"foo","glob":"*.py"}}'
	assert_success
}

@test "Grep *.py with no agent_id (main session) is allowed" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Grep","tool_input":{"pattern":"foo","glob":"*.py"}}'
	assert_success
}

# ── Bash grep on code file: executor denied ───────────────────────────────────

@test "Bash grep on .py file with agent_type=executor is denied (exit 2)" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","agent_id":"agt_exec01","agent_type":"oh-my-claudeagent:executor","tool_input":{"command":"grep foo src/main.py"}}'
	assert_failure 2
}

@test "Bash grep on .ts file with agent_type=executor is denied" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","agent_id":"agt_exec01","agent_type":"oh-my-claudeagent:executor","tool_input":{"command":"grep -r pattern src/index.ts"}}'
	assert_failure 2
}

# ── Bash grep on allowed extension: executor passes ──────────────────────────

@test "Bash grep on .json file with agent_type=executor is allowed" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","agent_id":"agt_exec01","agent_type":"oh-my-claudeagent:executor","tool_input":{"command":"grep foo data.json"}}'
	assert_success
}

@test "Bash grep on .log file with agent_type=executor is allowed" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","agent_id":"agt_exec01","agent_type":"oh-my-claudeagent:executor","tool_input":{"command":"grep ERROR app.log"}}'
	assert_success
}

# ── Bash non-grep command: always passes ─────────────────────────────────────

@test "Bash non-grep command with agent_type=executor is allowed" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","agent_id":"agt_exec01","agent_type":"oh-my-claudeagent:executor","tool_input":{"command":"ls src/"}}'
	assert_success
}

# ── Other tools: always passes ────────────────────────────────────────────────

@test "Read tool event is always allowed (not Grep or Bash)" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Read","agent_id":"agt_exec01","agent_type":"oh-my-claudeagent:executor","tool_input":{"file_path":"src/main.py"}}'
	assert_success
}

# ── never emits allow: silence is the only non-deny answer ────────────────────

@test "Bash grep with && second command emits no allow (main session)" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","tool_input":{"command":"grep foo data.json && ls /tmp"}}'
	assert_success
	assert_output ''
}

@test "Bash grep with pipe emits no allow (executor)" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","agent_id":"agt_exec01","agent_type":"oh-my-claudeagent:executor","tool_input":{"command":"grep foo data.json | sort"}}'
	assert_success
	assert_output ''
}

# CODE_EXT_REGEX is anchored at end-of-string, so a code file that is not the last
# token never reaches deny_grep. Pins the fall-through: the ast_search rule is
# unenforced for this shape, and the command is not auto-allowed either.
@test "Bash grep on a non-final code file falls through, not allowed" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","agent_id":"agt_exec01","agent_type":"oh-my-claudeagent:executor","tool_input":{"command":"grep foo main.py && ls /tmp"}}'
	assert_success
	assert_output ''
}

@test "Bash simple grep in main session emits nothing, not an allow" {
	run_hook "executor-grep-deny.sh" \
		'{"tool_name":"Bash","tool_input":{"command":"grep foo data.json"}}'
	assert_success
	assert_output ''
}

# ── full platform payload: the shape the CLI actually sends ───────────────────
# Regression pin for the field-name defect: the base hook payload carries
# {session_id, transcript_path, cwd, prompt_id, permission_mode, agent_id,
# agent_type, effort} and no top-level subagent_type. A fixture that omits
# agent_id/agent_type would let this gate pass every production call.

@test "REAL subagent payload: Grep *.rs inside executor is denied (exit 2)" {
	run_hook "executor-grep-deny.sh" \
		'{"session_id":"11111111-2222-3333-4444-555555555555","transcript_path":"/tmp/t.jsonl","cwd":"/tmp","prompt_id":"p1","permission_mode":"default","agent_id":"agt_abc123","agent_type":"oh-my-claudeagent:executor","effort":"medium","tool_name":"Grep","tool_input":{"pattern":"foo","glob":"*.rs"}}'
	assert_failure 2
	assert_output --partial 'ast_search'
}

@test "REAL subagent payload: Bash grep on a .rs file inside executor is denied (exit 2)" {
	run_hook "executor-grep-deny.sh" \
		'{"session_id":"11111111-2222-3333-4444-555555555555","cwd":"/tmp","prompt_id":"p1","permission_mode":"default","agent_id":"agt_abc123","agent_type":"oh-my-claudeagent:executor","effort":"medium","tool_name":"Bash","tool_input":{"command":"grep foo src/main.rs"}}'
	assert_failure 2
	assert_output --partial 'ast_search'
}

@test "REAL main-thread payload: agent_type present without agent_id is allowed" {
	run_hook "executor-grep-deny.sh" \
		'{"session_id":"11111111-2222-3333-4444-555555555555","cwd":"/tmp","permission_mode":"default","agent_type":"oh-my-claudeagent:executor","tool_name":"Grep","tool_input":{"pattern":"foo","glob":"*.rs"}}'
	assert_success
	assert_output ''
}
