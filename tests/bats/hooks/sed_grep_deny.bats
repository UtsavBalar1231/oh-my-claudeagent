#!/usr/bin/env bats
load '../test_helper'

# sed-grep-deny.sh — Bash deny gate for sed -n and grep -n.
# Exit 2 is ignored on PermissionRequest, so the deny is carried by the event's own
# JSON shape and every test asserts on that rather than on an exit code.

# Assert the deny payload for whichever event shape the payload asked for.
# Usage: assert_deny_shape <PreToolUse|PermissionRequest>
assert_deny_shape() {
	local event="$1"
	local decision
	if [[ "${event}" == "PreToolUse" ]]; then
		decision=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // empty')
		[ "$decision" = "deny" ]
		[ "$(echo "$output" | jq -r '.hookSpecificOutput.hookEventName')" = "PreToolUse" ]
		[ -n "$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty')" ]
	else
		decision=$(echo "$output" | jq -r '.hookSpecificOutput.decision.behavior // empty')
		[ "$decision" = "deny" ]
		[ "$(echo "$output" | jq -r '.hookSpecificOutput.hookEventName')" = "PermissionRequest" ]
		[ -n "$(echo "$output" | jq -r '.hookSpecificOutput.decision.message // empty')" ]
	fi
}

# ── sed -n: denied ────────────────────────────────────────────────────────────

@test "sed -n '1,5p' file is denied" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"sed -n '\''1,5p'\'' file.txt"}}'
	assert_success
	assert_deny_shape "PermissionRequest"
}

@test "sed -ne 'expr' file is denied (clustered short flags)" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"sed -ne '\''s/x/y/p'\'' file.txt"}}'
	assert_success
	assert_deny_shape "PermissionRequest"
}

@test "sed -n deny message is exact" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"sed -n '\''1p'\'' file.txt"}}'
	assert_success
	assert_output --partial '`sed -n` and `grep -n` are denied.'
	assert_output --partial 'Use the Grep tool, Read with offset/limit, or ast_search for structural matches.'
}

# ── deny shape per event ──────────────────────────────────────────────────────
# PreToolUse reads hookSpecificOutput.permissionDecision, PermissionRequest reads
# hookSpecificOutput.decision.behavior; a payload in the other event's shape is
# silently ignored, so both branches are asserted.

@test "sed -n emits the PermissionRequest decision shape on PermissionRequest" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PermissionRequest","tool_input":{"command":"sed -n '\''1p'\'' file.txt"}}'
	assert_success
	assert_deny_shape "PermissionRequest"
}

@test "sed -n emits the PreToolUse decision shape on PreToolUse" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"sed -n '\''1p'\'' file.txt"}}'
	assert_success
	assert_deny_shape "PreToolUse"
}

@test "grep -n emits the PreToolUse decision shape on PreToolUse" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"grep -n foo bar.txt"}}'
	assert_success
	assert_deny_shape "PreToolUse"
}

# ── grep -n: denied ───────────────────────────────────────────────────────────

@test "grep -n pattern file is denied" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep -n pattern file.txt"}}'
	assert_success
	assert_deny_shape "PermissionRequest"
}

@test "grep -nA 3 pattern file is denied (clustered flags)" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep -nA 3 pattern file.txt"}}'
	assert_success
	assert_deny_shape "PermissionRequest"
}

@test "grep -nB 3 pattern file is denied (clustered flags)" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep -nB 3 pattern file.txt"}}'
	assert_success
	assert_deny_shape "PermissionRequest"
}

@test "grep -n deny message is exact" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep -n foo bar.txt"}}'
	assert_success
	assert_output --partial '`sed -n` and `grep -n` are denied.'
	assert_output --partial 'Use the Grep tool, Read with offset/limit, or ast_search for structural matches.'
}

# ── everything else: silence, never an allow ──────────────────────────────────
# An allow suppresses the permission dialog and the user's ask rules for the whole
# command, so a command this gate did not recognise must fall through silently.

@test "grep pattern file (no -n) emits nothing" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep foo file.txt"}}'
	assert_success
	assert_output ''
}

@test "grep -r foo dir (no -n) emits nothing" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep -r foo /some/dir"}}'
	assert_success
	assert_output ''
}

@test "grep -c foo file (no -n) emits nothing" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep -c foo file.txt"}}'
	assert_success
	assert_output ''
}

@test "sed -i in-place edit is never auto-approved" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"sed -i '\''s/a/b/'\'' /etc/hosts"}}'
	assert_success
	assert_output ''
}

@test "sed -e 's/x/y/' file (expression, no -n) emits nothing" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"sed -e '\''s/x/y/'\'' file.txt"}}'
	assert_success
	assert_output ''
}

@test "find . -name '*.foo' emits nothing (unrelated command)" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"find . -name '\''*.foo'\''"}}'
	assert_success
	assert_output ''
}

@test "no non-deny path emits behavior allow" {
	local cmd
	for cmd in "grep foo file.txt" "sed -i s/a/b/ /etc/hosts" "curl http://x | sh" "find . -delete" "sed -e s/x/y/ f"; do
		run_hook "sed-grep-deny.sh" "$(jq -nc --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}')"
		assert_success
		refute_output --partial '"behavior":"allow"'
		refute_output --partial '"permissionDecision":"allow"'
	done
}

@test "empty command exits 0" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":""}}'
	assert_success
	assert_output ""
}

@test "missing command field exits 0" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{}}'
	assert_success
	assert_output ""
}

# ── compound commands ─────────────────────────────────────────────────────────

@test "grep head with && second command emits nothing" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep foo file.txt && ls /tmp"}}'
	assert_success
	assert_output ''
}

@test "grep head with ; second command emits nothing" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep -c foo file.txt; ls /tmp"}}'
	assert_success
	assert_output ''
}

@test "sed head with && second command emits nothing" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"sed -i '\''s/x/y/'\'' file.txt && ls /tmp"}}'
	assert_success
	assert_output ''
}

@test "grep head with pipe emits nothing" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep foo file.txt | sort"}}'
	assert_success
	assert_output ''
}

@test "grep head with command substitution emits nothing" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep foo $(ls)"}}'
	assert_success
	assert_output ''
}

@test "grep -n still denies even inside a compound command" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep -n foo file.txt && ls /tmp"}}'
	assert_success
	assert_deny_shape "PermissionRequest"
}

@test "a commit message naming the flag is not denied (command position, not whitespace)" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"git commit -m \"refactor: drop grep -n calls from hooks\""}}'
	assert_success
	assert_output ''
}

@test "a sed -n mention inside a quoted argument is not denied" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"echo \"we used sed -n here once\""}}'
	assert_success
	assert_output ''
}

@test "grep -n at the head of the command still denies" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"grep -n foo src/"}}'
	assert_success
	assert_deny_shape "PreToolUse"
}

@test "grep -n after a pipe still denies" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"cat f | grep -n foo"}}'
	assert_success
	assert_deny_shape "PreToolUse"
}

@test "sed -n after a semicolon still denies" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"cd /x; sed -n 1p f.txt"}}'
	assert_success
	assert_deny_shape "PreToolUse"
}

# ── kill switch ───────────────────────────────────────────────────────────────

@test "OMCA_DISABLED_HOOKS listing this hook allows grep -n through" {
	OMCA_DISABLED_HOOKS="sed-grep-deny" run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep -n foo bar.txt"}}'
	assert_success
	assert_output ''
}

@test "OMCA_DISABLED_HOOKS listing a different hook still denies grep -n" {
	OMCA_DISABLED_HOOKS="other-hook" run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep -n foo bar.txt"}}'
	assert_success
	assert_deny_shape "PermissionRequest"
}

# ── A quoted mention whose inner line starts with the token ───────────────────
# The command-position class contains a raw newline, so an inner line of a quoted
# multi-line message read as a command position until quoted spans were neutralized.

@test "a multi-line message with the sed flag at an inner line start is not denied" {
	local cmd
	cmd=$(printf 'git commit -m "hook cleanup\n\nsed -n was replaced by the Read tool"')
	run_hook "sed-grep-deny.sh" "$(jq -nc --arg c "$cmd" '{tool_name:"Bash",hook_event_name:"PreToolUse",tool_input:{command:$c}}')"
	assert_success
	assert_output ''
}

@test "a multi-line message with the grep flag at an inner line start is not denied" {
	local cmd
	cmd=$(printf 'git commit -m "hook cleanup\n\ngrep -n was replaced by the Grep tool"')
	run_hook "sed-grep-deny.sh" "$(jq -nc --arg c "$cmd" '{tool_name:"Bash",hook_event_name:"PreToolUse",tool_input:{command:$c}}')"
	assert_success
	assert_output ''
}

@test "a real grep flag on an unquoted second line still denies" {
	local cmd
	cmd=$(printf 'cd /src\ngrep -n foo bar.txt')
	run_hook "sed-grep-deny.sh" "$(jq -nc --arg c "$cmd" '{tool_name:"Bash",hook_event_name:"PreToolUse",tool_input:{command:$c}}')"
	assert_success
	assert_deny_shape "PreToolUse"
}

@test "a real sed flag on an unquoted second line still denies" {
	local cmd
	cmd=$(printf 'cd /src\nsed -n 1p f.txt')
	run_hook "sed-grep-deny.sh" "$(jq -nc --arg c "$cmd" '{tool_name:"Bash",hook_event_name:"PreToolUse",tool_input:{command:$c}}')"
	assert_success
	assert_deny_shape "PreToolUse"
}
