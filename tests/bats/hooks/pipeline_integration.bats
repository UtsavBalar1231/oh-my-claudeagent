#!/usr/bin/env bats
# Cross-script state pipeline integration tests
# These tests verify the STATE HANDOFF between hook scripts, not individual behavior.
# If script A changes its state file format, these tests catch the breakage in script B.

load '../test_helper'

# Override setup to use BATS_FILE_TMPDIR for cross-test persistence within pipeline sequences
setup() {
	export CLAUDE_PROJECT_ROOT="$BATS_FILE_TMPDIR/project"
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/state"
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/logs"
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/rules"
	# Use _TEST_HELPER_DIR from test_helper.bash (resolved at load time, reliable)
	export CLAUDE_PLUGIN_ROOT="$(cd "$_TEST_HELPER_DIR/../.." && pwd)"
	export CLAUDE_SESSION_ID="bats-pipeline-session"
}

# ─── c. Evidence → Task-Completion pipeline ──────────────────────────────────
# Write valid verification-evidence.json → task-completed-verify reads and allows

@test "pipeline c: valid fresh evidence allows task-completed-verify" {
	local now
	now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

	# Write valid verification-evidence.json with proper schema
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/evidence"
	cat > "$CLAUDE_PROJECT_ROOT/.omca/evidence/verification-evidence.json" <<-EOF
	{
	  "entries": [
	    {
	      "type": "test",
	      "command": "just test",
	      "exit_code": 0,
	      "output_snippet": "10 tests passed",
	      "timestamp": "$now"
	    }
	  ]
	}
	EOF

	# task-completed-verify should allow (evidence is fresh and valid)
	run_hook "task-completed-verify.sh" '{"task_description":"verify tests pass"}'
	assert_success
}

# ─── d. No Evidence + recent edits → Task-Completion blocked ────────────────
# No evidence file + recent edits.jsonl → task-completed-verify blocks with exit 2

@test "pipeline d: no evidence with recent edits blocks task-completed-verify" {
	# Explicitly remove evidence from previous pipeline test (shared BATS_FILE_TMPDIR)
	rm -f "$CLAUDE_PROJECT_ROOT/.omca/evidence/verification-evidence.json"

	# Write a recent edits.jsonl so the hook knows files were modified
	local now
	now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	printf '{"event":"edit","file":"src/foo.ts","timestamp":"%s"}\n' "$now" \
		> "$CLAUDE_PROJECT_ROOT/.omca/logs/edits.jsonl"

	# task description matches verification keywords
	run_hook "task-completed-verify.sh" '{"task_description":"all tests pass after fix"}'
	# Should be blocked (exit 2)
	assert [ "$status" -eq 2 ]
}

# ─── f. Compaction context pipeline ──────────────────────────────────────────
# pre-compact writes context, post-compact-inject restores

@test "pipeline f: compaction survival — pre-compact writes context, post-compact-inject restores" {
	# Write boulder.json with active plan reference
	write_state "boulder.json" \
		'{"active_plan":"/home/user/plans/my-plan.md","plan_name":"my-plan"}'

	# Step 1: run pre-compact — reads state, writes compaction-context.md
	run_hook "pre-compact.sh" '{}'
	assert_success

	local context_file="$CLAUDE_PROJECT_ROOT/.omca/state/compaction-context.md"
	assert [ -f "$context_file" ]

	# Step 2: run post-compact-inject — reads compaction-context.md, emits additionalContext, deletes the file
	run_hook "post-compact-inject.sh" '{"session_id":"bats-pipeline-session"}'
	assert_success

	# Output must contain the post-compaction restore marker
	assert_output --partial "POST-COMPACTION CONTEXT RESTORE"

	# compaction-context.md must be deleted after injection (consumed)
	assert [ ! -f "$context_file" ]
}

# ─── g. Context cache persistence pipeline ──────────────────────────────────
# context-injector for dir A → injected (cached) → dir A again → NOT injected → dir B → injected

@test "pipeline g: context-injector caches dir A, skips on second call, injects dir B" {
	# Create dir A with an AGENTS.md file
	local dir_a="$CLAUDE_PROJECT_ROOT/src/module-a"
	mkdir -p "$dir_a"
	printf '# AGENTS.md for module-a\nUse the standard patterns.\n' > "$dir_a/AGENTS.md"

	# Create a dummy file in dir A to simulate reading it
	printf 'export const foo = 1;\n' > "$dir_a/index.ts"

	# Create dir B with an AGENTS.md file
	local dir_b="$CLAUDE_PROJECT_ROOT/src/module-b"
	mkdir -p "$dir_b"
	printf '# AGENTS.md for module-b\nUse the module-b patterns.\n' > "$dir_b/AGENTS.md"
	printf 'export const bar = 2;\n' > "$dir_b/index.ts"

	local cache_file="$CLAUDE_PROJECT_ROOT/.omca/state/injected-context-dirs.json"

	# Step 1: Read from dir A — should inject AGENTS.md content (not yet cached)
	run_hook "context-injector.sh" \
		"{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$dir_a/index.ts\"}}"
	assert_success
	# Should produce context output (AGENTS.md injected)
	assert_output --partial "AGENTS.md from"
	assert_output --partial "module-a"

	# Cache file should now record dir A as injected
	# Cache key is "${dir}|${mtime}" — compute mtime to build the lookup key.
	assert [ -f "$cache_file" ]
	local dir_a_mtime dir_a_key dir_a_cached
	dir_a_mtime=$(stat -c %Y "$dir_a/AGENTS.md" 2>/dev/null || stat -f %m "$dir_a/AGENTS.md" 2>/dev/null || echo "0")
	dir_a_key="${dir_a}|${dir_a_mtime}"
	dir_a_cached=$(jq -r --arg d "$dir_a_key" '.[$d] // "false"' "$cache_file")
	assert [ "$dir_a_cached" = "true" ]

	# Step 2: Read from dir A again — should NOT inject (already cached)
	run_hook "context-injector.sh" \
		"{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$dir_a/index.ts\"}}"
	assert_success
	# No AGENTS.md context should be produced for dir A this time
	refute_output --partial "module-a"

	# Step 3: Read from dir B — should inject AGENTS.md (not yet cached)
	run_hook "context-injector.sh" \
		"{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$dir_b/index.ts\"}}"
	assert_success
	assert_output --partial "AGENTS.md from"
	assert_output --partial "module-b"

	# Cache file should now record dir B as injected too
	local dir_b_mtime dir_b_key dir_b_cached
	dir_b_mtime=$(stat -c %Y "$dir_b/AGENTS.md" 2>/dev/null || stat -f %m "$dir_b/AGENTS.md" 2>/dev/null || echo "0")
	dir_b_key="${dir_b}|${dir_b_mtime}"
	dir_b_cached=$(jq -r --arg d "$dir_b_key" '.[$d] // "false"' "$cache_file")
	assert [ "$dir_b_cached" = "true" ]
}
