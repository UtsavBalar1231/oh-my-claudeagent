#!/usr/bin/env bats
# Tests for scripts/drift-guard.sh — Stop hook that blocks a completion claim
# when the diff against HEAD (or untracked files) still contains stub markers
# on added lines. Uses a real git repo per test (drift-guard is OMCA's first
# git-running hook, so a synthetic .git dir like the shared test_helper setup
# provides is not sufficient here).

load '../test_helper'

setup() {
	export CLAUDE_PROJECT_ROOT="$BATS_TEST_TMPDIR/project"
	mkdir -p "$CLAUDE_PROJECT_ROOT/.omca/state" "$CLAUDE_PROJECT_ROOT/.omca/logs"
	export CLAUDE_PLUGIN_ROOT="$(cd "$_TEST_HELPER_DIR/../.." && pwd)"
	export CLAUDE_SESSION_ID="bats-test-session"

	cd "$CLAUDE_PROJECT_ROOT"
	git init -q
	git config user.email "test@example.com"
	git config user.name "Test"
}

_commit_all() {
	git add -A
	git commit -qm "seed"
}

_claim_payload() {
	local text="$1"
	jq -n --arg t "$text" '{"hook_event_name":"Stop","stop_hook_active":false,"messages":[{"role":"assistant","content":$t}]}'
}

@test "drift-guard: clean repo with completion claim allows Stop" {
	echo "hello" > a.txt
	_commit_all

	run_hook "drift-guard.sh" "$(_claim_payload 'All done, implemented and fixed.')"
	assert_success
	assert_output '{}'
}

@test "drift-guard: .only marker on an added line blocks with exit 2" {
	echo "hello" > a.txt
	_commit_all
	echo "it.only('t', () => {})" >> a.txt

	run_hook "drift-guard.sh" "$(_claim_payload 'Done, all tests pass.')"
	assert_failure 2
	assert_output --partial "a.txt"
	assert_output --partial "only"
}

@test "drift-guard: marker on a pre-existing unchanged line allows Stop" {
	printf 'line1\nit.only("x")\nline3\n' > preexist.txt
	_commit_all
	echo "unrelated new line" >> preexist.txt

	run_hook "drift-guard.sh" "$(_claim_payload 'Implemented and fixed.')"
	assert_success
	assert_output '{}'
}

@test "drift-guard: untracked new stub file blocks with exit 2" {
	echo "hello" > a.txt
	_commit_all
	echo "TODO: implement" > new.txt

	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	assert_failure 2
	assert_output --partial "new.txt"
}

@test "drift-guard: untracked binary file does not crash and is not a false block" {
	echo "hello" > a.txt
	_commit_all
	head -c 64 /bin/ls > bin.dat 2>/dev/null || printf '\x00\x01\x02\xff\xfe' > bin.dat

	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	assert_success
	assert_output '{}'
}

@test "drift-guard: non-git directory fails open (allows Stop)" {
	local nongit="$BATS_TEST_TMPDIR/nongit"
	mkdir -p "$nongit"
	export CLAUDE_PROJECT_ROOT="$nongit"

	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	assert_success
	assert_output '{}'
}

@test "drift-guard: repo with no commits (no HEAD) fails open (allows Stop)" {
	echo "TODO: implement" > new.txt

	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	assert_success
	assert_output '{}'
}

@test "drift-guard: kill switch (OMCA_HOOK_DISABLE_DRIFT_GUARD=1) allows Stop" {
	echo "hello" > a.txt
	_commit_all
	echo "TODO: implement" > new.txt

	OMCA_HOOK_DISABLE_DRIFT_GUARD=1 run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	assert_success
	assert_output --partial "Kill switch"
}

@test "drift-guard: assistant text extracted from transcript_path when messages is absent" {
	echo "hello" > a.txt
	_commit_all
	echo "TODO: implement" > new.txt

	local transcript="$BATS_TEST_TMPDIR/transcript.jsonl"
	cat > "$transcript" <<EOF
{"type":"user","message":{"role":"user","content":"go"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done, all fixed."}]}}
{"type":"last-prompt","lastPrompt":"x"}
EOF
	local payload
	payload=$(jq -n --arg tp "$transcript" '{"hook_event_name":"Stop","stop_hook_active":false,"transcript_path":$tp}')

	run_hook "drift-guard.sh" "$payload"
	assert_failure 2
	assert_output --partial "new.txt"
}

@test "drift-guard: negated completion claim (not done) allows Stop despite a stub" {
	echo "hello" > a.txt
	_commit_all
	echo "TODO: implement" > new.txt

	run_hook "drift-guard.sh" "$(_claim_payload 'This is not done yet.')"
	assert_success
	assert_output '{}'
}

@test "drift-guard: HOOK_INPUT_TIMED_OUT=1 warns and allows Stop" {
	HOOK_INPUT="" HOOK_INPUT_TIMED_OUT=1 run bash "$CLAUDE_PLUGIN_ROOT/scripts/drift-guard.sh" < /dev/null
	assert_success
	assert_output --partial "stdin read timed out"
}
