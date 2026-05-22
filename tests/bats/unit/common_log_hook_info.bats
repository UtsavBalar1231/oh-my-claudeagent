#!/usr/bin/env bats
# Unit tests for log_hook_info helper in scripts/lib/common.sh

load '../test_helper'

@test "log_hook_info: writes a valid JSON line to hook-info.jsonl" {
	# Source common.sh in the isolated project root context
	export HOOK_PROJECT_ROOT="$CLAUDE_PROJECT_ROOT"
	export HOOK_LOG_DIR="$CLAUDE_PROJECT_ROOT/.omca/logs"

	bash -c "
		export HOOK_PROJECT_ROOT='$CLAUDE_PROJECT_ROOT'
		export HOOK_LOG_DIR='$CLAUDE_PROJECT_ROOT/.omca/logs'
		source '$CLAUDE_PLUGIN_ROOT/scripts/lib/common.sh'
		log_hook_info 'test message' 'test-source'
	"

	local log_file="$CLAUDE_PROJECT_ROOT/.omca/logs/hook-info.jsonl"
	[ -f "$log_file" ]

	local line
	line=$(tail -1 "$log_file")

	# Validate it is parseable JSON
	echo "$line" | jq -c '.' >/dev/null

	# Validate all 4 required fields are present with correct values
	[ "$(echo "$line" | jq -r '.level')" = "info" ]
	[ "$(echo "$line" | jq -r '.hook')" = "test-source" ]
	[ "$(echo "$line" | jq -r '.message')" = "test message" ]

	# timestamp must be a non-empty string
	local ts
	ts=$(echo "$line" | jq -r '.timestamp')
	[ -n "$ts" ]
}

@test "log_hook_info: defaults source to basename of script when not provided" {
	export HOOK_PROJECT_ROOT="$CLAUDE_PROJECT_ROOT"
	export HOOK_LOG_DIR="$CLAUDE_PROJECT_ROOT/.omca/logs"

	# Write a small wrapper script so basename \$0 is deterministic
	local wrapper="$BATS_TEST_TMPDIR/my-hook.sh"
	cat > "$wrapper" <<'EOF'
#!/usr/bin/env bash
export HOOK_PROJECT_ROOT="${HOOK_PROJECT_ROOT}"
export HOOK_LOG_DIR="${HOOK_LOG_DIR}"
source "${COMMON_SH}"
log_hook_info "default source test"
EOF
	chmod +x "$wrapper"

	COMMON_SH="$CLAUDE_PLUGIN_ROOT/scripts/lib/common.sh" \
		HOOK_PROJECT_ROOT="$CLAUDE_PROJECT_ROOT" \
		HOOK_LOG_DIR="$CLAUDE_PROJECT_ROOT/.omca/logs" \
		bash "$wrapper"

	local log_file="$CLAUDE_PROJECT_ROOT/.omca/logs/hook-info.jsonl"
	[ -f "$log_file" ]

	local line
	line=$(tail -1 "$log_file")

	[ "$(echo "$line" | jq -r '.hook')" = "my-hook.sh" ]
}
