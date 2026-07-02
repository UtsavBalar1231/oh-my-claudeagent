#!/usr/bin/env bats
# Behavioral tests for plan-format-warn.sh (PostToolUse Write|Edit advisory hook).
# Warns (never blocks) when a plan file's raw `- [ ]` checkbox count exceeds
# its numbered `- [ ] N.` count, naming the malformed lines.

load '../test_helper'

# Build a PostToolUse Write payload for the given plan file path
_payload() {
	local file_path="$1"
	printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$file_path"
}

@test "plan-format-warn: malformed checkbox line triggers a warning naming it" {
	mkdir -p "$CLAUDE_PROJECT_ROOT/plans"
	local plan_file="$CLAUDE_PROJECT_ROOT/plans/test-plan.md"
	cat > "$plan_file" <<'EOF'
# My Plan

- [ ] 1. First task
- [ ] Task 2: malformed, no number-dot
EOF

	run_hook "plan-format-warn.sh" "$(_payload "$plan_file")"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "Task 2"
	assert echo "$ctx" | grep -q "will not be counted"
	assert echo "$ctx" | grep -q "N\."
}

@test "plan-format-warn: well-formed plan emits no output" {
	mkdir -p "$CLAUDE_PROJECT_ROOT/plans"
	local plan_file="$CLAUDE_PROJECT_ROOT/plans/good-plan.md"
	cat > "$plan_file" <<'EOF'
# My Plan

- [ ] 1. First task
- [x] 2. Second task
EOF

	run_hook "plan-format-warn.sh" "$(_payload "$plan_file")"
	assert_success
	[ -z "$output" ]
}

@test "plan-format-warn: non-plan file path emits no output" {
	mkdir -p "$CLAUDE_PROJECT_ROOT/src"
	local other_file="$CLAUDE_PROJECT_ROOT/src/notes.md"
	cat > "$other_file" <<'EOF'
- [ ] Task 2: malformed, no number-dot
EOF

	run_hook "plan-format-warn.sh" "$(_payload "$other_file")"
	assert_success
	[ -z "$output" ]
}

@test "plan-format-warn: OMCA_DISABLED_HOOKS kill switch suppresses output" {
	mkdir -p "$CLAUDE_PROJECT_ROOT/plans"
	local plan_file="$CLAUDE_PROJECT_ROOT/plans/test-plan.md"
	cat > "$plan_file" <<'EOF'
- [ ] 1. First task
- [ ] Task 2: malformed, no number-dot
EOF

	OMCA_DISABLED_HOOKS="plan-format-warn" run_hook "plan-format-warn.sh" "$(_payload "$plan_file")"
	assert_success
	[ -z "$output" ]
}
