#!/usr/bin/env bats
# Behavioral tests for miscellaneous hook scripts

load '../test_helper'

# ---------------------------------------------------------------------------
# a. write-guard: overwrite warning for existing file
# ---------------------------------------------------------------------------

@test "write-guard: warns when target file already exists" {
	local target="$CLAUDE_PROJECT_ROOT/existing-file.txt"
	printf 'content' > "$target"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "Detected manual write"
}

# ---------------------------------------------------------------------------
# b. write-guard: no warning for non-existent file
# ---------------------------------------------------------------------------

@test "write-guard: no warning when target file does not exist" {
	local target="$CLAUDE_PROJECT_ROOT/new-file-does-not-exist.txt"
	# Ensure the file does not exist
	rm -f "$target"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# c. write-guard: evidence intercept for verification-evidence.json
# ---------------------------------------------------------------------------

@test "write-guard: intercepts writes targeting verification-evidence.json" {
	local target="$CLAUDE_PROJECT_ROOT/.omca/state/verification-evidence.json"

	local payload
	payload=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$target")

	run_hook "write-guard.sh" "$payload"
	assert_success

	local decision
	decision=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // empty')
	[ "$decision" = "deny" ]
}

# ---------------------------------------------------------------------------
# d. comment-checker: warns on TODO: implement
# ---------------------------------------------------------------------------

@test "comment-checker: warns when content contains 'TODO: implement'" {
	local content=$'function foo() {\n  // TODO: implement this\n  return null;\n}'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "TODO"
}

# The two cases below replace MultiEdit twins, removed because the tool does not
# exist. Edit is the non-Write half of the Write|Edit matcher, and it carries
# new_string as a scalar rather than an edits[] array.

@test "comment-checker: warns for Edit new_string content" {
	local dirty=$'function foo() {\n  // TODO: implement this\n  return null;\n}'
	local payload
	payload=$(jq -nc --arg dirty "$dirty" '{"tool_name":"Edit","tool_input":{"old_string":"","new_string":$dirty}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "TODO"
}

@test "comment-checker: no warning for clean Edit new_string content" {
	local clean=$'function foo() {\n  return 1;\n}'
	local payload
	payload=$(jq -nc --arg clean "$clean" '{"tool_name":"Edit","tool_input":{"old_string":"","new_string":$clean}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: warns for apply_patch added lines" {
	local patch=$'*** Begin Patch\n*** Update File: example.py\n@@\n def foo():\n+    # AI-generated helper\n+    return 1\n-    return 0\n*** End Patch'
	local payload
	payload=$(jq -nc --arg patch "$patch" '{"tool_name":"apply_patch","tool_input":{"patchText":$patch}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "AI attribution"
}

# ---------------------------------------------------------------------------
# f2. comment-checker: slop-pattern categories (code-restating, filler words,
# decorative separators, trivial doc comments, context-free TODO/FIXME)
# ---------------------------------------------------------------------------

@test "comment-checker: warns on code-restating comment" {
	local content=$'# set user name to input value\nuser_name = input_value'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "restates the following code line"
}

# The restates check previously required the comment to contribute zero words
# of its own, so it only ever matched hand-built cases like the test above.
# Real narration carries a word the code line lacks; these lock that in.
@test "comment-checker: warns on narrating comment that adds one word" {
	local content=$'# Set the path attribute\nself.path = path'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "restates the following code line"
}

@test "comment-checker: warns on line-by-line narration via density" {
	local content=$'# Define the configuration class\nclass Config:\n    # Initialize the configuration\n    def __init__(self, path):\n        # Store the path\n        self.path = path\n        # Create an empty dict\n        self.values = {}\n    # Load the config file\n    def load(self):\n        # Open and parse it\n        return json.load(open(self.path))'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "comment density"
}

# Load-bearing comments the rules file mandates. A tightening pass that
# silences these has overshot, so failures here are the intended alarm.
@test "comment-checker: no warning for magic-number derivation comment" {
	local content=$'# 3600s (1h) - F1-F4 evidence freshness window. Sibling uses 300s; UNDOCUMENTED divergence.\nMAX_EVIDENCE_AGE_SECONDS=3600'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

# The terse mandated form restates its constant by construction, so it is
# exempted by shape. Without that carve-out the gate blocks a comment the
# rules file REQUIRES on every numeric constant.
@test "comment-checker: no warning for terse magic-number comment" {
	local content=$'# 300s evidence age\nMAX_EVIDENCE_AGE_SECONDS=300'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/tmp/x.sh","content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

# A machine-readable pragma is addressed to a linter, not to a reader, so its
# token overlap with the line below is the directive naming its own target.
# This is the convention comment-checker.sh's own source follows.
@test "comment-checker: shellcheck source directive is not a restatement" {
	local content=$'# shellcheck source=lib/common.sh\nsource "$(dirname "$0")/lib/common.sh"'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/repo/scripts/foo.sh","content":$c}}')

	OMCA_COMMENT_GATE=deny run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: still denies a genuine restatement in a shell script" {
	local content=$'# set the user name\nuser_name="$input_value"'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/repo/scripts/foo.sh","content":$c}}')

	OMCA_COMMENT_GATE=deny run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output --partial "restates the following code line"
}

# The exemption matches the directive form at the start of the comment body. A
# comment that merely names a linter mid-sentence is prose and stays in scope.
@test "comment-checker: pragma keyword mid-comment is not exempt" {
	local content=$'# the path for noqa\nself.path = path'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/repo/x.py","content":$c}}')

	OMCA_COMMENT_GATE=deny run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output --partial "restates the following code line"
}

# `#` opens a preprocessor directive in C, not a comment. While the marker set
# was language-blind, every `#include` was read as a comment restating the line
# under it, and a header-only edit could not be written at all.
@test "comment-checker: C preprocessor directives are not comments" {
	local content=$'#include "pamir_ks_ta.h"\nstatic const char pamir_id[] = "x";'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/repo/ta/pamir_ks_ta.c","content":$c}}')

	OMCA_COMMENT_GATE=deny run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: still catches a restating // comment in C" {
	local content=$'// set the user name\nuser_name = input_value;'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/repo/ta/x.c","content":$c}}')

	OMCA_COMMENT_GATE=deny run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output --partial "restates the following code line"
}

# Tier 1 matched a literal "# " prefix, so an attribution comment was invisible
# in every language whose marker is not `#`.
@test "comment-checker: tier-1 denies an attribution comment behind a // marker" {
	local content=$'// AI-generated helper\nint f(void) { return 1; }'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/repo/ta/x.c","content":$c}}')

	OMCA_COMMENT_GATE=deny run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output --partial "AI attribution comment detected"
}

@test "comment-checker: reads -- as the comment marker in Lua" {
	local content=$'-- set the user name\nuser_name = input_value'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/repo/x.lua","content":$c}}')

	OMCA_COMMENT_GATE=deny run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output --partial "restates the following code line"
}

# A comment that names an attribution phrase mid-sentence is a mention, not an
# instance: only the phrase at the start of the comment body is the thing itself.
@test "comment-checker: tier-1 ignores an attribution phrase mid-comment" {
	local content=$'// the gate below denies an ai-generated banner\nint f(void) { return 1; }'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/repo/ta/x.c","content":$c}}')

	OMCA_COMMENT_GATE=deny run_hook "comment-checker.sh" "$payload"
	assert_success
	refute_output --partial "AI attribution comment detected"
}

@test "comment-checker: skips non-source files so Markdown headings are not comments" {
	local content=$'# Install dependencies\njust install\n\n# Run the tests\njust test\n\n# Build the plugin\njust build\n\n# Release a version\njust release\n\n# Clean the cache\njust clean\n\n# Lint the shell\njust lint'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/tmp/README.md","content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

# Tier 1 scans comment lines only. A gate that fires on a banned string reached
# through a string literal or a grep pattern cannot tell code that DOES a thing
# from code that talks ABOUT it, and this repo writes guards about its guards.
@test "comment-checker: tier-1 ignores a banned string inside a grep pattern" {
	local content=$'if grep -qi "# AI-generated" "$f"; then deny; fi'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/repo/scripts/new-gate.sh","content":$c}}')

	OMCA_COMMENT_GATE=deny run_hook "comment-checker.sh" "$payload"
	assert_success
	refute_output --partial "permissionDecision"
}

@test "comment-checker: tier-1 ignores banned strings inside a list literal" {
	local content=$'BANNED = ["TODO: implement", "# AI-generated"]'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/repo/servers/fixtures.py","content":$c}}')

	OMCA_COMMENT_GATE=deny run_hook "comment-checker.sh" "$payload"
	assert_success
	refute_output --partial "permissionDecision"
}

@test "comment-checker: tier-1 still denies an attribution comment in the same file shape" {
	local content=$'# AI-generated helper\nif grep -qi "x" "$f"; then deny; fi'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/repo/scripts/new-gate.sh","content":$c}}')

	OMCA_COMMENT_GATE=deny run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output --partial '"permissionDecision":"deny"'
	assert_output --partial "AI attribution comment detected"
}

@test "comment-checker: tier-1 still denies a TODO placeholder comment" {
	local content=$'# TODO: implement\ndef f():\n    pass'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/repo/servers/fixtures.py","content":$c}}')

	OMCA_COMMENT_GATE=deny run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output --partial '"permissionDecision":"deny"'
	assert_output --partial "Unimplemented TODO placeholder detected"
}

@test "comment-checker: advise mode reports a tier-1 comment but never denies" {
	local content=$'# This code was written by an assistant\nfoo() { :; }'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/tmp/x.sh","content":$c}}')

	OMCA_COMMENT_GATE=advise run_hook "comment-checker.sh" "$payload"
	assert_success
	refute_output --partial "permissionDecision"
	ctx=$(get_context)
	assert echo "$ctx" | grep -qi "AI authorship comment detected"
}

@test "comment-checker: advise mode stays silent on a banned string in a literal" {
	local content=$'BANNED = ["# This code was written by"]'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/repo/servers/fixtures.py","content":$c}}')

	OMCA_COMMENT_GATE=advise run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: skips its own source so the gate cannot self-trip" {
	local content=$'# AI-generated helper\nfoo() { :; }'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/repo/scripts/comment-checker.sh","content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: advise mode emits context and never denies" {
	local content=$'# AI-generated helper\nfoo() { :; }'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/tmp/x.sh","content":$c}}')

	OMCA_COMMENT_GATE=advise run_hook "comment-checker.sh" "$payload"
	assert_success
	refute_output --partial "permissionDecision"
	ctx=$(get_context)
	assert [ -n "$ctx" ]
}

@test "comment-checker: deny mode blocks tier-1 literal patterns" {
	local content=$'# AI-generated helper\nfoo() { :; }'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/tmp/x.sh","content":$c}}')

	OMCA_COMMENT_GATE=deny run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output --partial '"permissionDecision":"deny"'
	assert_output --partial "REQUIRED and must survive"
}

@test "comment-checker: gate off exits silently" {
	local content=$'# AI-generated helper\nfoo() { :; }'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"file_path":"/tmp/x.sh","content":$c}}')

	OMCA_COMMENT_GATE=off run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: no warning for invariant comment" {
	local content=$'# REQUIRES RALPH_STATE to be set upstream - see resolve_session_id above.\nif [[ -z "$RALPH_STATE" ]]; then\n  return 1\nfi'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: no warning when comment adds information code doesn't restate" {
	local content=$'# cache the previous input value for diffing on next call\nuser_name = input_value'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: warns on filler-word qualifier comment" {
	local content=$'# obviously this handles the edge case\nfoo()'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "Filler-word comment"
}

@test "comment-checker: no warning for comment without filler qualifiers" {
	local content=$'# handles the edge case for empty input\nfoo()'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: warns on decorative separator comment" {
	local content=$'# ====================\nfoo()'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "Decorative separator comment"
}

@test "comment-checker: no warning for a labeled section-banner comment" {
	local content=$'# === Section: Setup ===\nfoo()'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: warns on trivial doc comment above a one-line function" {
	local content=$'# returns the user id\ndef get_user_id():\n    return self.id\n'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "Doc comment adds nothing beyond the function name"
}

@test "comment-checker: no warning for a doc comment that adds real information" {
	local content=$'# validates against the external billing service and retries on timeout\ndef get_user_id():\n    return self.id\n'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: warns on context-free TODO with no ref/owner/explanation" {
	local content=$'# TODO fix this\nfoo()'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "Context-free TODO/FIXME"
}

@test "comment-checker: no warning for TODO carrying an issue reference" {
	local content=$'# TODO(#123): fix this after upstream releases a patch\nfoo()'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: @allow bypasses slop-pattern checks on that line" {
	local content=$'# obviously simple @allow\nfoo()'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: comment-checker-disable-file marker exempts the whole payload" {
	local content=$'# comment-checker-disable-file\n# obviously this is bad\nfoo()'
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

@test "comment-checker: OMCA_DISABLED_HOOKS bypasses detection entirely" {
	local content="# AI-generated code\ndef foo():\n    pass"
	local payload
	payload=$(jq -nc --arg c "$content" '{"tool_name":"Write","tool_input":{"content":$c}}')

	OMCA_DISABLED_HOOKS="comment-checker" run_hook "comment-checker.sh" "$payload"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# g. empty-task-response: warns on empty/very short agent output
# ---------------------------------------------------------------------------

@test "empty-task-response: warns when agent output is empty" {
	local payload
	payload='{"tool_name":"Task","tool_input":{"subagent_type":"explore"},"tool_response":""}'

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "POOR AGENT OUTPUT"
}

@test "empty-task-response: warns when agent output is very short" {
	local payload
	payload='{"tool_name":"Task","tool_input":{"subagent_type":"explore"},"tool_response":"ok"}'

	run_hook "empty-task-response.sh" "$payload"
	assert_success
	ctx=$(get_context)
	assert [ -n "$ctx" ]
	echo "$ctx" | grep -qi "POOR AGENT OUTPUT"
}
