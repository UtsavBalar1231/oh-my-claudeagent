#!/usr/bin/env bats
load '../test_helper'

# ─── git-destructive-deny.sh tests ────────────────────────────────────────────

bash_payload() {
	printf '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"%s"}}' "$1"
}

permreq_payload() {
	printf '{"tool_name":"Bash","hook_event_name":"PermissionRequest","tool_input":{"command":"%s"}}' "$1"
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

# ─── Subcommand terminated by a separator rather than whitespace ───────────────
# The deny now runs on PreToolUse for every Bash call, so a subcommand that ends on
# a separator has to deny too. It previously did not: the trailing match required
# whitespace or end of string, so `git stash;` and `echo $(git stash)` walked past.

@test "git-destructive-deny: git stash followed by a semicolon is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git stash; echo ok')"
	assert_failure 2
	assert_output --partial "Destructive git"
}

@test "git-destructive-deny: git stash backgrounded is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git stash&')"
	assert_failure 2
}

@test "git-destructive-deny: git stash piped is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git stash|cat')"
	assert_failure 2
}

@test "git-destructive-deny: git stash inside a substitution is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'echo $(git stash)')"
	assert_failure 2
}

@test "git-destructive-deny: git clean redirected is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git clean >/tmp/out')"
	assert_failure 2
}

# ─── sudo prefix ───────────────────────────────────────────────────────────────
# Without the optional sudo the command carried no operator, so it reached the
# trailing allow and was auto-approved rather than merely falling through.

@test "git-destructive-deny: sudo git clean -fdx is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'sudo git clean -fdx')"
	assert_failure 2
	assert_output --partial "Destructive git"
}

@test "git-destructive-deny: sudo git reset --hard is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'sudo git reset --hard')"
	assert_failure 2
}

# ─── Subcommand prefixes and non-path checkout flags stay out of scope ─────────
# `git checkout --` discards working tree changes; `git checkout --detach` does not,
# and denying it was over-matching that the separator requirement removed.

@test "git-destructive-deny: git cleanup is allowed" {
	run_hook "git-destructive-deny.sh" "$(bash_payload 'git cleanup')"
	assert_success
}

@test "git-destructive-deny: git stashy is allowed" {
	run_hook "git-destructive-deny.sh" "$(bash_payload 'git stashy')"
	assert_success
}

@test "git-destructive-deny: git checkout --detach is allowed" {
	run_hook "git-destructive-deny.sh" "$(bash_payload 'git checkout --detach')"
	assert_success
}

@test "git-destructive-deny: git checkout --track origin/x is allowed" {
	run_hook "git-destructive-deny.sh" "$(bash_payload 'git checkout --track origin/x')"
	assert_success
}

@test "git-destructive-deny: git checkout -- . is still blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git checkout -- .')"
	assert_failure 2
}

# ─── Opt-out via env var ────────────────────────────────────────────────────────

@test "git-destructive-deny: opt-out via OMCA_HOOK_DISABLE_GIT_DESTRUCTIVE_DENY=1 allows reset --hard" {
	OMCA_HOOK_DISABLE_GIT_DESTRUCTIVE_DENY=1 \
		run bash -c "bash ${CLAUDE_PLUGIN_ROOT}/scripts/git-destructive-deny.sh 2>&1" \
		<<< "$(bash_payload 'git reset --hard')"
	assert_success
}

@test "git-destructive-deny: OMCA_DISABLED_HOOKS listing this hook allows reset --hard" {
	OMCA_DISABLED_HOOKS="git-destructive-deny" \
		run bash -c "bash ${CLAUDE_PLUGIN_ROOT}/scripts/git-destructive-deny.sh 2>&1" \
		<<< "$(bash_payload 'git reset --hard')"
	assert_success
}

# ─── Spellings that reach the same working-tree loss ───────────────────────────
# The subcommand match previously required `git <subcommand>` at the head, so a
# leading global option or a revision before `--` walked past it.

@test "git-destructive-deny: checkout of a revision followed by -- is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git checkout HEAD -- .')"
	assert_failure 2
	assert_output --partial "Destructive git"
}

@test "git-destructive-deny: a -C redirected reset --hard is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git -C /repo reset --hard')"
	assert_failure 2
}

@test "git-destructive-deny: a --git-dir redirected reset --hard is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git --git-dir=/repo/.git reset --hard')"
	assert_failure 2
}

@test "git-destructive-deny: a -c config-override reset --hard is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git -c user.name=x reset --hard')"
	assert_failure 2
}

@test "git-destructive-deny: git rm of a tree is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git rm -rf .')"
	assert_failure 2
}

@test "git-destructive-deny: a quoted subcommand is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git \"reset\" --hard')"
	assert_failure 2
}

# ─── Destructive text inside a quoted argument is not a command ────────────────
# `(` and `)` were separators in the leading class with no quote tracking, so the
# words below denied from inside a message or a search pattern. A single false
# positive on a read-only command teaches the user to disable the guard for good.

@test "git-destructive-deny: a commit message naming the subcommand in parens is not blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git commit -m \"restore state (git stash used)\"')"
	assert_success
	assert_output ""
}

@test "git-destructive-deny: a read-only log pickaxe search in parens is not blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git log --oneline -S \"(git restore)\"')"
	assert_success
	assert_output ""
}

@test "git-destructive-deny: a chained checkout with a later -- token is not blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git checkout main && echo -- x')"
	assert_success
	assert_output ""
}

# ─── No path emits an allow ────────────────────────────────────────────────────
# An allow suppresses the permission dialog and the user's ask rules, so a command
# this gate did not classify as destructive falls through silently. The old trailing
# allow auto-approved a hooksPath rewrite, which is code execution on the next commit.

@test "git-destructive-deny: a core.hooksPath rewrite is never auto-approved" {
	run_hook "git-destructive-deny.sh" "$(bash_payload 'git config --local core.hooksPath /tmp/evil')"
	assert_success
	assert_output ""
}

@test "git-destructive-deny: no non-deny path emits behavior allow" {
	local cmd
	for cmd in "git status" "git log" "git config --local core.hooksPath /tmp/evil" "git push --force" "git fetch"; do
		run_hook "git-destructive-deny.sh" "$(jq -nc --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}')"
		assert_success
		refute_output --partial '"behavior":"allow"'
		refute_output --partial '"permissionDecision":"allow"'
	done
}

@test "git-destructive-deny: git rm --cached is not blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git rm --cached secrets.env')"
	assert_success
	assert_output ""
}

@test "git-destructive-deny: git rm of a single file is not blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git rm stale.txt')"
	assert_success
	assert_output ""
}

@test "git-destructive-deny: git rm -r of a directory is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git rm -r vendor/')"
	assert_failure 2
	assert_output --partial "Destructive git"
}

@test "git-destructive-deny: a space-separated --git-dir reset --hard is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git --git-dir /r/.git reset --hard')"
	assert_failure 2
}

@test "git-destructive-deny: a space-separated --work-tree reset --hard is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git --work-tree /w reset --hard')"
	assert_failure 2
}

@test "git-destructive-deny: a --no-pager reset --hard is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git --no-pager reset --hard')"
	assert_failure 2
}

@test "git-destructive-deny: an attached -c config override reset --hard is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git -cuser.name=x reset --hard')"
	assert_failure 2
}

@test "git-destructive-deny: a --bare clean -fdx is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git --bare clean -fdx')"
	assert_failure 2
}

@test "git-destructive-deny: git --no-pager log is allowed" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git --no-pager log')"
	assert_success
	assert_output ""
}

@test "git-destructive-deny: a subshell clean -fdx is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload '(git clean -fdx)')"
	assert_failure 2
}

@test "git-destructive-deny: a subshell stash is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload '(git stash)')"
	assert_failure 2
}

@test "git-destructive-deny: a subshell reset --hard is blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload '(git reset --hard)')"
	assert_failure 2
}

@test "git-destructive-deny: a commit message naming the subcommand after a semicolon is not blocked" {
	run_hook_merged "git-destructive-deny.sh" "$(bash_payload 'git commit -m \"cleanup; git stash was used\"')"
	assert_success
	assert_output ""
}

@test "git-destructive-deny: a single-quoted message naming the subcommand in backticks is not blocked" {
	run_hook_merged "git-destructive-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"git commit -m '"'"'drop the `git stash` step'"'"'"}}'
	assert_success
	assert_output ""
}

@test "git-destructive-deny: reset --hard emits the PermissionRequest deny shape" {
	run_hook "git-destructive-deny.sh" "$(permreq_payload 'git reset --hard')"
	assert_success
	[ "$(echo "$output" | jq -r '.hookSpecificOutput.hookEventName')" = "PermissionRequest" ]
	[ "$(echo "$output" | jq -r '.hookSpecificOutput.decision.behavior')" = "deny" ]
	[ -n "$(echo "$output" | jq -r '.hookSpecificOutput.decision.message // empty')" ]
}

@test "git-destructive-deny: an absent hook_event_name reads as PermissionRequest" {
	run_hook "git-destructive-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"git reset --hard"}}'
	assert_success
	[ "$(echo "$output" | jq -r '.hookSpecificOutput.decision.behavior')" = "deny" ]
}

@test "git-destructive-deny: git status emits no allow on PermissionRequest" {
	run_hook "git-destructive-deny.sh" "$(permreq_payload 'git status')"
	assert_success
	assert_output ""
}

@test "git-destructive-deny: OMCA_DISABLED_HOOKS listing a different hook still denies reset --hard" {
	OMCA_DISABLED_HOOKS="other-hook" \
		run bash -c "bash ${CLAUDE_PLUGIN_ROOT}/scripts/git-destructive-deny.sh 2>&1" \
		<<< "$(bash_payload 'git reset --hard')"
	assert_failure 2
}
