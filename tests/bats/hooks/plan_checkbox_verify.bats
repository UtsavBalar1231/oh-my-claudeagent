#!/usr/bin/env bats
# Behavioral tests for plan-checkbox-verify.sh
# Verifies that Write operations on plan files require at least one - [ ] N. checkbox.

load '../test_helper'

# ---------------------------------------------------------------------------
# (a) Write of plan with ## TODOs header and checkboxes → exit 0
# ---------------------------------------------------------------------------

@test "plan-checkbox-verify: plan with ## TODOs and checkboxes passes (exit 0)" {
	local content
	content=$'# My Plan\n\n## TODOs\n\n- [ ] 1. Do the first thing\n- [ ] 2. Do the second thing\n'
	local payload
	payload=$(jq -nc --arg fp "/home/user/.claude/plans/my-agent-abc123.md" --arg c "$content" \
		'{"tool_name":"Write","tool_input":{"file_path":$fp,"content":$c}}')

	run_hook "plan-checkbox-verify.sh" "$payload"
	assert_success
}

# ---------------------------------------------------------------------------
# (b) Write of plan with ## TODOs but no checkboxes → exit 2, stderr names checkbox
# ---------------------------------------------------------------------------

@test "plan-checkbox-verify: plan with ## TODOs but no checkboxes fails (exit 2)" {
	local content
	content=$'# My Plan\n\n## TODOs\n\nno checkboxes here, just prose\n'
	local payload
	payload=$(jq -nc --arg fp "/home/user/.claude/plans/my-agent-abc123.md" --arg c "$content" \
		'{"tool_name":"Write","tool_input":{"file_path":$fp,"content":$c}}')

	run_hook "plan-checkbox-verify.sh" "$payload"
	[ "$status" -eq 2 ]
	# stderr must mention checkbox or - [ ]
	echo "$output" | grep -qiE 'checkbox|\- \[ \]'
}

# ---------------------------------------------------------------------------
# (c) Write of non-plan file → exit 0 (path does not match */plans/*.md)
# ---------------------------------------------------------------------------

@test "plan-checkbox-verify: non-plan file path is ignored (exit 0)" {
	local payload
	payload=$(jq -nc \
		'{"tool_name":"Write","tool_input":{"file_path":"/tmp/notes.md","content":"hello world"}}')

	run_hook "plan-checkbox-verify.sh" "$payload"
	assert_success
}

# ---------------------------------------------------------------------------
# (d) Read tool input → exit 0 (not our concern)
# ---------------------------------------------------------------------------

@test "plan-checkbox-verify: Read tool input is ignored (exit 0)" {
	local payload
	payload=$(jq -nc \
		'{"tool_name":"Read","tool_input":{"file_path":"/home/user/.claude/plans/my-agent-abc123.md"}}')

	run_hook "plan-checkbox-verify.sh" "$payload"
	assert_success
}

# ---------------------------------------------------------------------------
# (e) Markdown in plans/ without plan header → exit 0 (not a plan)
# ---------------------------------------------------------------------------

@test "plan-checkbox-verify: plans/README.md without plan header is ignored (exit 0)" {
	local content
	content=$'# Plans directory\n\nThis directory stores plan files.\n'
	local payload
	payload=$(jq -nc --arg fp "/home/user/.claude/plans/README.md" --arg c "$content" \
		'{"tool_name":"Write","tool_input":{"file_path":$fp,"content":$c}}')

	run_hook "plan-checkbox-verify.sh" "$payload"
	assert_success
}

# ---------------------------------------------------------------------------
# (f) Edit tool input on existing plan → exit 0 (only Write is checked)
# ---------------------------------------------------------------------------

@test "plan-checkbox-verify: Edit tool on plan file is ignored (exit 0)" {
	local payload
	payload=$(jq -nc \
		'{"tool_name":"Edit","tool_input":{"file_path":"/home/user/.claude/plans/my-agent-abc123.md","old_string":"foo","new_string":"bar"}}')

	run_hook "plan-checkbox-verify.sh" "$payload"
	assert_success
}

# ---------------------------------------------------------------------------
# (g) Write of plan with ## Work Objectives header and checkboxes → exit 0
# ---------------------------------------------------------------------------

@test "plan-checkbox-verify: plan with ## Work Objectives header and checkboxes passes (exit 0)" {
	local content
	content=$'# Sprint Plan\n\n## Work Objectives\n\n- [ ] 1. Implement feature\n- [ ] 2. Write tests\n'
	local payload
	payload=$(jq -nc --arg fp "/home/user/.claude/plans/sprint-agent-xyz.md" --arg c "$content" \
		'{"tool_name":"Write","tool_input":{"file_path":$fp,"content":$c}}')

	run_hook "plan-checkbox-verify.sh" "$payload"
	assert_success
}

# ---------------------------------------------------------------------------
# (h) Write of plan with ## Work Objectives but no checkboxes → exit 2
# ---------------------------------------------------------------------------

@test "plan-checkbox-verify: plan with ## Work Objectives but no checkboxes fails (exit 2)" {
	local content
	content=$'# Sprint Plan\n\n## Work Objectives\n\nObjective 1: do a thing\nObjective 2: do another thing\n'
	local payload
	payload=$(jq -nc --arg fp "/home/user/.claude/plans/sprint-agent-xyz.md" --arg c "$content" \
		'{"tool_name":"Write","tool_input":{"file_path":$fp,"content":$c}}')

	run_hook "plan-checkbox-verify.sh" "$payload"
	[ "$status" -eq 2 ]
}

# ---------------------------------------------------------------------------
# (i) Write of *-agent-*.md filename (naming convention match) with checkboxes → exit 0
# ---------------------------------------------------------------------------

@test "plan-checkbox-verify: agent-named plan file with checkboxes passes (exit 0)" {
	local content
	content=$'# Agent Plan\n\n- [ ] 1. First task\n'
	local payload
	payload=$(jq -nc --arg fp "/home/user/.claude/plans/cool-cooking-sifakis-agent-deadbeef.md" --arg c "$content" \
		'{"tool_name":"Write","tool_input":{"file_path":$fp,"content":$c}}')

	run_hook "plan-checkbox-verify.sh" "$payload"
	assert_success
}

# ---------------------------------------------------------------------------
# (j) Write of *-agent-*.md filename with no checkboxes and no header → exit 2
# ---------------------------------------------------------------------------

@test "plan-checkbox-verify: agent-named plan file without checkboxes fails (exit 2)" {
	local content
	content=$'# Agent Plan\n\nThis plan has no checkboxes at all.\n'
	local payload
	payload=$(jq -nc --arg fp "/home/user/.claude/plans/cool-cooking-sifakis-agent-deadbeef.md" --arg c "$content" \
		'{"tool_name":"Write","tool_input":{"file_path":$fp,"content":$c}}')

	run_hook "plan-checkbox-verify.sh" "$payload"
	[ "$status" -eq 2 ]
}
