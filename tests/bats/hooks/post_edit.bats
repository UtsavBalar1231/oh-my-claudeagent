#!/usr/bin/env bats
# Behavioral tests for post-edit.sh

load '../test_helper'

@test "post-edit: concurrent writes produce no data loss in recent-edits.json" {
	local n=5
	local pids=()

	for i in $(seq 1 "$n"); do
		local payload
		payload=$(jq -nc --argjson i "$i" '{
			tool_name: "Write",
			tool_input: { file_path: ("/concurrent/file-" + ($i | tostring) + ".sh") }
		}')
		bash "$CLAUDE_PLUGIN_ROOT/scripts/post-edit.sh" <<< "$payload" &
		pids+=("$!")
	done

	for pid in "${pids[@]}"; do
		wait "$pid"
	done

	local edits_file="$CLAUDE_PROJECT_ROOT/.omca/state/recent-edits.json"
	assert [ -f "$edits_file" ]

	# Every distinct file path must be present — no writes lost
	local count
	count=$(jq '.files | length' "$edits_file")
	[ "$count" -eq "$n" ]
}
