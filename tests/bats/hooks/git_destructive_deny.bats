#!/usr/bin/env bats
load '../test_helper'

# ─── git-destructive-deny.sh tests ────────────────────────────────────────────

# Helper: build a Bash tool hook payload with the given command string
bash_payload() {
	printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$1"
}

# Run a hook and merge stderr into stdout so assert_output can inspect denial messages.
# Usage: run_hook_merged <script-name> <json-string>
run_hook_merged() {
	local script="$1"
	local payload="$2"
	run bash -c "bash ${CLAUDE_PLUGIN_ROOT}/scripts/${script} 2>&1" <<< "${payload}"
}

# ─── Blocked commands (exit 2, stderr matches "Destructive git") ───────────────

@test "git-destructive-deny: git reset --hard HEAD~1 is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git reset --hard HEAD~1')"
	assert_failure 2
	assert_output --partial "Destructive git"
}

@test "git-destructive-deny: git reset --hard (no args) is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git reset --hard')"
	assert_failure 2
	assert_output --partial "Destructive git"
}

@test "git-destructive-deny: git stash (bare) is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git stash')"
	assert_failure 2
	assert_output --partial "Destructive git"
}

@test "git-destructive-deny: git stash push is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git stash push')"
	assert_failure 2
	assert_output --partial "Destructive git"
}

@test "git-destructive-deny: git stash pop is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git stash pop')"
	assert_failure 2
	assert_output --partial "Destructive git"
}

@test "git-destructive-deny: git checkout -- src/foo.py is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git checkout -- src/foo.py')"
	assert_failure 2
	assert_output --partial "Destructive git"
}

@test "git-destructive-deny: git clean -fd is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git clean -fd')"
	assert_failure 2
	assert_output --partial "Destructive git"
}

@test "git-destructive-deny: git restore foo.py is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git restore foo.py')"
	assert_failure 2
	assert_output --partial "Destructive git"
}

# ─── Allowed commands (exit 0) ─────────────────────────────────────────────────

@test "git-destructive-deny: git status is allowed" {
	run_hook "git-destructive-deny.sh" "$(bash_payload 'git status')"
	assert_success
}

@test "git-destructive-deny: git log is allowed" {
	run_hook "git-destructive-deny.sh" "$(bash_payload 'git log')"
	assert_success
}

@test "git-destructive-deny: git diff is allowed" {
	run_hook "git-destructive-deny.sh" "$(bash_payload 'git diff')"
	assert_success
}

@test "git-destructive-deny: git commit -m is allowed" {
	run_hook "git-destructive-deny.sh" "$(bash_payload 'git commit -m "msg"')"
	assert_success
}

@test "git-destructive-deny: git push is allowed" {
	run_hook "git-destructive-deny.sh" "$(bash_payload 'git push')"
	assert_success
}

@test "git-destructive-deny: git pull is allowed" {
	run_hook "git-destructive-deny.sh" "$(bash_payload 'git pull')"
	assert_success
}

@test "git-destructive-deny: git fetch is allowed" {
	run_hook "git-destructive-deny.sh" "$(bash_payload 'git fetch')"
	assert_success
}

@test "git-destructive-deny: git blame foo.py is allowed" {
	run_hook "git-destructive-deny.sh" "$(bash_payload 'git blame foo.py')"
	assert_success
}

@test "git-destructive-deny: git bisect start is allowed" {
	run_hook "git-destructive-deny.sh" "$(bash_payload 'git bisect start')"
	assert_success
}

@test "git-destructive-deny: git rebase main is allowed" {
	run_hook "git-destructive-deny.sh" "$(bash_payload 'git rebase main')"
	assert_success
}

# ─── Opt-out via env var ────────────────────────────────────────────────────────

@test "git-destructive-deny: opt-out via OMCA_HOOK_DISABLE_GIT_DESTRUCTIVE_DENY=1 allows reset --hard" {
	OMCA_HOOK_DISABLE_GIT_DESTRUCTIVE_DENY=1 \
		run bash -c "bash ${CLAUDE_PLUGIN_ROOT}/scripts/git-destructive-deny.sh 2>&1" \
		<<< "$(bash_payload 'git reset --hard')"
	assert_success
}
