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
	jq -n --arg t "$text" '{"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":$t}'
}

# A Stop block is exit 0 with the decision on stdout.
_assert_blocked() {
	assert_success
	[ "$(jq -r '.decision' <<< "$output")" = "block" ]
	[ -n "$(jq -r '.reason // ""' <<< "$output")" ]
}

@test "drift-guard: clean repo with completion claim allows Stop" {
	echo "hello" > a.txt
	_commit_all

	run_hook "drift-guard.sh" "$(_claim_payload 'All done, implemented and fixed.')"
	assert_success
	assert_output '{}'
}

@test "drift-guard: .only marker on an added line blocks Stop" {
	echo "hello" > a.txt
	_commit_all
	echo "it.only('t', () => {})" >> a.txt

	run_hook "drift-guard.sh" "$(_claim_payload 'Done, all tests pass.')"
	_assert_blocked
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

@test "drift-guard: untracked new stub file blocks Stop" {
	echo "hello" > a.txt
	_commit_all
	echo "TODO: implement" > new.txt

	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	_assert_blocked
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

@test "drift-guard: OMCA_DISABLED_HOOKS listing this hook allows Stop" {
	echo "hello" > a.txt
	_commit_all
	echo "TODO: implement" > new.txt

	OMCA_DISABLED_HOOKS="drift-guard" run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	assert_success
	refute_output --partial '"decision"'
}

@test "drift-guard: OMCA_DISABLED_HOOKS listing a different hook still blocks" {
	echo "hello" > a.txt
	_commit_all
	echo "TODO: implement" > new.txt

	OMCA_DISABLED_HOOKS="other-hook" run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	_assert_blocked
}

@test "drift-guard: assistant text extracted from transcript_path when last_assistant_message is absent" {
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
	_assert_blocked
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

# Both fixtures assemble the marker from split literals so that this suite is
# not itself a finding: the guard scans the file it writes, not the line here.
@test "drift-guard: a marker inside a bats test name is not a finding" {
	echo "hello" > a.txt
	_commit_all
	local marker="it.on""ly"
	printf '@test "guard: %s marker on an added line blocks Stop" {\n\ttrue\n}\n' "$marker" > suite.bats

	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	assert_success
	assert_output '{}'
}

@test "drift-guard: a marker in a bats test body is still a finding" {
	echo "hello" > a.txt
	_commit_all
	local body="it.on""ly(\"x\")"
	printf '@test "guard: something" {\n\t%s\n}\n' "$body" > suite.bats

	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	_assert_blocked
	assert_output --partial "suite.bats"
}

# The Markdown fixtures below also assemble the marker from split literals, for
# the same reason: this suite must not become its own finding.
@test "drift-guard: a backticked marker in Markdown is not a finding" {
	echo "hello" > a.txt
	_commit_all
	local marker="TODO: imple""ment"
	printf 'Bare `%s` is not a comment.\n' "$marker" > doc.md

	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	assert_success
	assert_output '{}'
}

@test "drift-guard: a marker inside a fenced code block in Markdown is not a finding" {
	echo "hello" > a.txt
	_commit_all
	local marker="TODO: imple""ment"
	printf 'Bad example:\n\n```go\n// %s pagination\n```\n' "$marker" > doc.md

	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	assert_success
	assert_output '{}'
}

@test "drift-guard: a bare marker in Markdown prose is still a finding" {
	echo "hello" > a.txt
	_commit_all
	local marker="TODO: imple""ment"
	printf 'Still to do: %s the pagination path.\n' "$marker" > doc.md

	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	_assert_blocked
	assert_output --partial "doc.md"
}

@test "drift-guard: the Markdown carve-out does not leak to non-Markdown files" {
	echo "hello" > a.txt
	_commit_all
	local marker="TODO: imple""ment"
	printf '# Bare `%s` is not a comment.\n' "$marker" > script.sh

	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	_assert_blocked
	assert_output --partial "script.sh"
}

@test "drift-guard: HOOK_INPUT_TIMED_OUT=1 warns and allows Stop" {
	HOOK_INPUT="" HOOK_INPUT_TIMED_OUT=1 run bash "$CLAUDE_PLUGIN_ROOT/scripts/drift-guard.sh" < /dev/null
	assert_success
	assert_output --partial "stdin read timed out"
}

# ---------------------------------------------------------------------------
# Marker precision
# ---------------------------------------------------------------------------

# `.only` is a projection call in several ORMs (Django, Peewee). A bare
# `\.only\b` flagged it, and there is no way for the author to resolve the
# finding short of disabling the gate.
@test "drift-guard: an ORM .only() projection is not a finding" {
	echo "hello" > a.txt
	_commit_all
	printf 'qs = Model.objects.only("id")\nrow = User.select().only(User.id)\n' > orm.py

	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	assert_success
	assert_output '{}'
}

@test "drift-guard: a focused test .only is still a finding" {
	echo "hello" > a.txt
	_commit_all
	local marker="describe.on""ly"
	printf '%s("suite", () => {})\n' "$marker" > spec.js

	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	_assert_blocked
	assert_output --partial "spec.js"
}

# ---------------------------------------------------------------------------
# Loop bounding and cost ceiling
# ---------------------------------------------------------------------------

# drift-guard had no counter of any kind: an unresolved stub plus a completion
# claim blocked every Stop for the rest of the session, and the only recovery
# was killing the client.
@test "drift-guard: an unresolved stub stops blocking once the Stop-block cap is hit" {
	echo "hello" > a.txt
	_commit_all
	echo "TODO: implement" > new.txt

	local decisions="" i
	# 7 > HARD_CAP_BLOCKS (5).
	for i in 1 2 3 4 5 6 7; do
		run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
		decisions+="$(jq -r '.decision // "allow"' <<< "$output") "
	done

	assert_equal "$decisions" "block block block block block allow allow "
}

@test "drift-guard: resolving the stub restores the Stop-block budget" {
	echo "hello" > a.txt
	_commit_all
	echo "TODO: implement" > new.txt

	local i
	for i in 1 2 3 4 5 6; do
		run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	done
	assert_output '{}'

	echo "resolved" > new.txt
	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	assert_output '{}'

	echo "TODO: implement" > another.txt
	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	_assert_blocked
}

@test "drift-guard: jq unavailable allows Stop" {
	echo "hello" > a.txt
	_commit_all
	echo "TODO: implement" > new.txt

	local dir="$BATS_TEST_TMPDIR/nojq-bin"
	mkdir -p "$dir"
	local c p
	for c in bash cat date grep sed cut tr basename dirname mktemp mv rm mkdir \
		flock printf sha256sum tail head sort wc awk tac stat chmod git; do
		p=$(command -v "$c" 2>/dev/null) && ln -sf "$p" "$dir/$c"
	done

	run env -i PATH="$dir" HOME="$HOME" CLAUDE_PROJECT_ROOT="$CLAUDE_PROJECT_ROOT" \
		CLAUDE_PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT" \
		HOOK_INPUT='{"stop_hook_active":false,"last_assistant_message":"Done."}' \
		HOOK_INPUT_TIMED_OUT=0 \
		"$dir/bash" "$CLAUDE_PLUGIN_ROOT/scripts/drift-guard.sh" < /dev/null
	assert_success
	refute_output --partial '"decision"'
}

# The scan costs about 1ms per changed file with no ceiling, so a codegen run or
# a vendored-tree import froze turn-end for tens of seconds. Above the ceiling
# the guard skips instead of stalling.
@test "drift-guard: a tree above the changed-file ceiling skips the scan" {
	local i
	mkdir -p src
	for i in $(seq 1 520); do echo "line" > "src/f$i.txt"; done
	_commit_all
	for i in $(seq 1 520); do echo "TODO: implement" >> "src/f$i.txt"; done

	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	assert_success
	assert_output --partial "exceeds the 500-file scan ceiling"
	refute_output --partial '"decision"'
}

@test "drift-guard: a tree just under the ceiling still scans and blocks" {
	local i
	mkdir -p src
	for i in $(seq 1 40); do echo "line" > "src/f$i.txt"; done
	_commit_all
	echo "TODO: implement" >> src/f7.txt

	run_hook "drift-guard.sh" "$(_claim_payload 'Done.')"
	_assert_blocked
	assert_output --partial "src/f7.txt"
}
