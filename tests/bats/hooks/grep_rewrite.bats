#!/usr/bin/env bats
load '../test_helper'

# sed-grep-deny.sh rewrites a mechanically translatable grep into the rg spelling
# instead of denying it. The two events carry different allow shapes, so every case
# is asserted per event. Anything the translator will not vouch for keeps denying,
# and the rewritten command is asserted in full: a substring match would not catch a
# dropped flag or a mangled operand, which is the failure mode that matters here.

# Usage: assert_rewrite <PreToolUse|PermissionRequest> <expected command>
assert_rewrite() {
	local event="$1" expected="$2"
	if [[ "${event}" == "PreToolUse" ]]; then
		[ "$(echo "$output" | jq -r '.hookSpecificOutput.hookEventName')" = "PreToolUse" ]
		[ "$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision')" = "allow" ]
		[ "$(echo "$output" | jq -r '.hookSpecificOutput.updatedInput.command')" = "${expected}" ]
	else
		[ "$(echo "$output" | jq -r '.hookSpecificOutput.hookEventName')" = "PermissionRequest" ]
		[ "$(echo "$output" | jq -r '.hookSpecificOutput.decision.behavior')" = "allow" ]
		[ "$(echo "$output" | jq -r '.hookSpecificOutput.decision.updatedInput.command')" = "${expected}" ]
	fi
}

# Usage: assert_deny_shape <PreToolUse|PermissionRequest>
assert_deny_shape() {
	local event="$1"
	if [[ "${event}" == "PreToolUse" ]]; then
		[ "$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision')" = "deny" ]
		[ "$(echo "$output" | jq -r '.hookSpecificOutput.hookEventName')" = "PreToolUse" ]
	else
		[ "$(echo "$output" | jq -r '.hookSpecificOutput.decision.behavior')" = "deny" ]
		[ "$(echo "$output" | jq -r '.hookSpecificOutput.hookEventName')" = "PermissionRequest" ]
	fi
}

# ── the target case, per event ────────────────────────────────────────────────

@test "grep -rn X path is rewritten to rg -n X path on PreToolUse" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"grep -rn foo src/"}}'
	assert_success
	assert_rewrite "PreToolUse" "rg -n foo src/"
}

@test "grep -rn X path is rewritten to rg -n X path on PermissionRequest" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PermissionRequest","tool_input":{"command":"grep -rn foo src/"}}'
	assert_success
	assert_rewrite "PermissionRequest" "rg -n foo src/"
}

@test "an absent hook_event_name takes the PermissionRequest allow shape" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","tool_input":{"command":"grep -rn foo src/"}}'
	assert_success
	assert_rewrite "PermissionRequest" "rg -n foo src/"
}

# ── updatedInput replaces the whole input object ──────────────────────────────
# Every field the call carried has to come back, since the platform substitutes the
# object wholesale rather than merging it.

@test "updatedInput carries every field of the original tool_input" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"grep -rn foo src/","description":"search src","timeout":120000,"run_in_background":false}}'
	assert_success
	local updated
	updated=$(echo "$output" | jq -c '.hookSpecificOutput.updatedInput')
	[ "$updated" = '{"command":"rg -n foo src/","description":"search src","timeout":120000,"run_in_background":false}' ]
}

@test "updatedInput on PermissionRequest also carries every original field" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PermissionRequest","tool_input":{"command":"grep -rn foo src/","description":"search src","run_in_background":true}}'
	assert_success
	local updated
	updated=$(echo "$output" | jq -c '.hookSpecificOutput.decision.updatedInput')
	[ "$updated" = '{"command":"rg -n foo src/","description":"search src","run_in_background":true}' ]
}

# ── other translatable spellings ──────────────────────────────────────────────

@test "quoting in the operand tail survives the rewrite byte for byte" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"grep -rni \"foo bar\" src/ tests/"}}'
	assert_success
	assert_rewrite "PreToolUse" 'rg -ni "foo bar" src/ tests/'
}

@test "a single-file grep -n is rewritten" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"grep -n foo bar.txt"}}'
	assert_success
	assert_rewrite "PreToolUse" "rg -n foo bar.txt"
}

@test "each short-flag token is translated in order" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"grep -rn -i foo src/"}}'
	assert_success
	assert_rewrite "PreToolUse" "rg -n -i foo src/"
}

# The gate only recognises an n-flag in the first flag token, so a later one never
# reaches the translator. Pinned here so a rewrite is never assumed for this shape.
@test "an n-flag in a later token is neither denied nor rewritten" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"grep -r -n -i foo src/"}}'
	assert_success
	assert_output ''
}

# ── refused: still denies, on both events ─────────────────────────────────────

@test "a value-taking flag denies on PreToolUse" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"grep -nA 3 foo src/"}}'
	assert_success
	assert_deny_shape "PreToolUse"
}

@test "a value-taking flag denies on PermissionRequest" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PermissionRequest","tool_input":{"command":"grep -nA 3 foo src/"}}'
	assert_success
	assert_deny_shape "PermissionRequest"
}

@test "a long flag denies" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"grep -n --include=*.py foo src/"}}'
	assert_success
	assert_deny_shape "PreToolUse"
}

@test "an ERE flag denies, because rg regex is not grep ERE" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"grep -nE \"a|b\" src/"}}'
	assert_success
	assert_deny_shape "PreToolUse"
}

@test "a pipe denies" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"grep -rn foo src/ | sort"}}'
	assert_success
	assert_deny_shape "PreToolUse"
}

@test "a redirect denies" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"grep -rn foo src/ > out.txt"}}'
	assert_success
	assert_deny_shape "PreToolUse"
}

@test "a command substitution denies" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"grep -rn foo $(ls)"}}'
	assert_success
	assert_deny_shape "PreToolUse"
}

@test "a second subcommand denies" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"grep -rn foo src/ && ls /tmp"}}'
	assert_success
	assert_deny_shape "PreToolUse"
}

@test "a flag after the first operand denies" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"grep -n foo src/ -r"}}'
	assert_success
	assert_deny_shape "PreToolUse"
}

@test "sed -n is never rewritten and denies on PreToolUse" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"sed -n 1,5p file.txt"}}'
	assert_success
	assert_deny_shape "PreToolUse"
}

@test "sed -n is never rewritten and denies on PermissionRequest" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PermissionRequest","tool_input":{"command":"sed -n 1,5p file.txt"}}'
	assert_success
	assert_deny_shape "PermissionRequest"
}

@test "a grep not matched by the gate is still silent, never an allow" {
	run_hook "sed-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","tool_input":{"command":"grep -r foo src/"}}'
	assert_success
	assert_output ''
}

# ── the executor gate is not softened by the rewrite ──────────────────────────
# executor-grep-deny.sh forbids plain text-grep on code so the executor reaches for
# ast_search. rg is the same plain text-grep, so translating there would reverse the
# policy rather than restate the command; it keeps denying on both events, and
# PreToolUse precedence (deny > allow) means its deny wins over any sibling rewrite.

@test "executor grep on a code file still denies on PreToolUse" {
	run_hook "executor-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PreToolUse","agent_id":"a1","agent_type":"oh-my-claudeagent:executor","tool_input":{"command":"grep -rn foo src/main.py"}}'
	assert_failure 2
	assert_output --partial 'ast_search'
}

@test "executor grep on a code file still denies on PermissionRequest" {
	run_hook "executor-grep-deny.sh" '{"tool_name":"Bash","hook_event_name":"PermissionRequest","agent_id":"a1","agent_type":"oh-my-claudeagent:executor","tool_input":{"command":"grep -rn foo src/main.py"}}'
	assert_success
	assert_deny_shape "PermissionRequest"
}
