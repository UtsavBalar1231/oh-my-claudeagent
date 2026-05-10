#!/usr/bin/env bats
# Behavioral tests for context-injector.sh (PostToolUse hook)

load '../test_helper'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Build a PostToolUse payload for the given tool and file path
_payload() {
	local tool="$1"
	local file_path="$2"
	printf '{"tool_name":"%s","tool_input":{"file_path":"%s"}}' "$tool" "$file_path"
}

# ---------------------------------------------------------------------------
# a. AGENTS.md injection on Read
# ---------------------------------------------------------------------------

@test "AGENTS.md: injected when reading a file in a dir containing AGENTS.md" {
	mkdir -p "$CLAUDE_PROJECT_ROOT/subdir"
	echo "# My Agents Guide" > "$CLAUDE_PROJECT_ROOT/subdir/AGENTS.md"
	touch "$CLAUDE_PROJECT_ROOT/subdir/file.txt"

	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/subdir/file.txt")"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "My Agents Guide"
}

@test "AGENTS.md: injection label includes directory path" {
	mkdir -p "$CLAUDE_PROJECT_ROOT/subdir"
	echo "agent content here" > "$CLAUDE_PROJECT_ROOT/subdir/AGENTS.md"
	touch "$CLAUDE_PROJECT_ROOT/subdir/file.txt"

	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/subdir/file.txt")"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "AGENTS.md from"
}

# ---------------------------------------------------------------------------
# b. README.md injection on Read
# ---------------------------------------------------------------------------

@test "README.md: injected when reading a file in a dir containing README.md" {
	mkdir -p "$CLAUDE_PROJECT_ROOT/subdir"
	echo "# Project README" > "$CLAUDE_PROJECT_ROOT/subdir/README.md"
	touch "$CLAUDE_PROJECT_ROOT/subdir/file.txt"

	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/subdir/file.txt")"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "Project README"
}

@test "README.md: injection label includes directory path" {
	mkdir -p "$CLAUDE_PROJECT_ROOT/subdir"
	echo "readme content" > "$CLAUDE_PROJECT_ROOT/subdir/README.md"
	touch "$CLAUDE_PROJECT_ROOT/subdir/file.txt"

	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/subdir/file.txt")"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "README.md from"
}

# ---------------------------------------------------------------------------
# c. No AGENTS.md/README.md injection on Write
# ---------------------------------------------------------------------------

@test "AGENTS.md: NOT injected for Write events (Read-only directory traversal)" {
	mkdir -p "$CLAUDE_PROJECT_ROOT/subdir"
	echo "# Secret Agent Docs" > "$CLAUDE_PROJECT_ROOT/subdir/AGENTS.md"
	touch "$CLAUDE_PROJECT_ROOT/subdir/file.txt"

	run_hook "context-injector.sh" "$(_payload Write "$CLAUDE_PROJECT_ROOT/subdir/file.txt")"
	assert_success
	ctx=$(get_context)
	[[ "$ctx" != *"Secret Agent Docs"* ]]
}

@test "README.md: NOT injected for Write events" {
	mkdir -p "$CLAUDE_PROJECT_ROOT/subdir"
	echo "# Secret README" > "$CLAUDE_PROJECT_ROOT/subdir/README.md"
	touch "$CLAUDE_PROJECT_ROOT/subdir/file.txt"

	run_hook "context-injector.sh" "$(_payload Write "$CLAUDE_PROJECT_ROOT/subdir/file.txt")"
	assert_success
	ctx=$(get_context)
	[[ "$ctx" != *"Secret README"* ]]
}

# ---------------------------------------------------------------------------
# d. Cache dedup: second Read for same dir produces no AGENTS.md injection
# ---------------------------------------------------------------------------

@test "cache dedup: second Read for same directory skips AGENTS.md injection" {
	mkdir -p "$CLAUDE_PROJECT_ROOT/subdir"
	echo "# Unique Agent Content" > "$CLAUDE_PROJECT_ROOT/subdir/AGENTS.md"
	touch "$CLAUDE_PROJECT_ROOT/subdir/file.txt"

	# First call — should inject
	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/subdir/file.txt")"
	assert_success
	ctx=$(get_context)
	[[ "$ctx" == *"Unique Agent Content"* ]]

	# Second call — should NOT inject (cached)
	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/subdir/file.txt")"
	assert_success
	ctx=$(get_context)
	[[ "$ctx" != *"Unique Agent Content"* ]]
}

@test "cache dedup: injected-context-dirs.json records the mtime-keyed entry after first Read" {
	mkdir -p "$CLAUDE_PROJECT_ROOT/subdir"
	echo "# Cache test" > "$CLAUDE_PROJECT_ROOT/subdir/AGENTS.md"
	touch "$CLAUDE_PROJECT_ROOT/subdir/file.txt"

	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/subdir/file.txt")"
	assert_success

	local cache="$CLAUDE_PROJECT_ROOT/.omca/state/injected-context-dirs.json"
	assert [ -f "$cache" ]
	# Cache key is "${dir}|${mtime}" — verify at least one entry whose key starts with the dir
	local recorded
	recorded=$(jq -r 'to_entries[] | select(.key | startswith("'"$CLAUDE_PROJECT_ROOT/subdir|"'")) | .value' "$cache")
	assert [ "$recorded" = "true" ]
}

# ---------------------------------------------------------------------------
# d2. mtime invalidation: editing AGENTS.md re-injects on next Read
# ---------------------------------------------------------------------------

@test "mtime invalidation: editing AGENTS.md causes re-injection on next Read" {
	mkdir -p "$CLAUDE_PROJECT_ROOT/subdir"
	echo "# Original content" > "$CLAUDE_PROJECT_ROOT/subdir/AGENTS.md"
	touch "$CLAUDE_PROJECT_ROOT/subdir/file.txt"

	# First call — injects original content
	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/subdir/file.txt")"
	assert_success
	ctx=$(get_context)
	[[ "$ctx" == *"Original content"* ]]

	# Modify AGENTS.md — advance mtime so the cache key changes
	sleep 1
	echo "# Updated content" > "$CLAUDE_PROJECT_ROOT/subdir/AGENTS.md"

	# Second call — mtime changed, cache key is new → re-inject with updated content
	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/subdir/file.txt")"
	assert_success
	ctx=$(get_context)
	[[ "$ctx" == *"Updated content"* ]]
}

# ---------------------------------------------------------------------------
# e. Rule pattern matching fires on Read
# ---------------------------------------------------------------------------

@test "rule matching: *.tsx rule injected when reading a .tsx file" {
	printf '# pattern: *.tsx\nUse functional components only.' \
		> "$CLAUDE_PROJECT_ROOT/.omca/rules/react.md"
	touch "$CLAUDE_PROJECT_ROOT/Component.tsx"

	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/Component.tsx")"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "Use functional components only"
}

@test "rule matching: rule label includes the glob pattern" {
	printf '# pattern: *.tsx\nReact rule content.' \
		> "$CLAUDE_PROJECT_ROOT/.omca/rules/react.md"
	touch "$CLAUDE_PROJECT_ROOT/Component.tsx"

	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/Component.tsx")"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "Rule: \*\.tsx"
}

# ---------------------------------------------------------------------------
# f. Rule fires on Write too
# ---------------------------------------------------------------------------

@test "rule matching: *.tsx rule injected on Write event too" {
	printf '# pattern: *.tsx\nAlways co-locate styles.' \
		> "$CLAUDE_PROJECT_ROOT/.omca/rules/react.md"
	touch "$CLAUDE_PROJECT_ROOT/Component.tsx"

	run_hook "context-injector.sh" "$(_payload Write "$CLAUDE_PROJECT_ROOT/Component.tsx")"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "Always co-locate styles"
}

# ---------------------------------------------------------------------------
# g. Rule non-match
# ---------------------------------------------------------------------------

@test "rule non-match: *.tsx rule NOT injected when reading a .sh file" {
	printf '# pattern: *.tsx\nReact-only content.' \
		> "$CLAUDE_PROJECT_ROOT/.omca/rules/react.md"
	touch "$CLAUDE_PROJECT_ROOT/script.sh"

	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/script.sh")"
	assert_success
	ctx=$(get_context)
	[[ "$ctx" != *"React-only content"* ]]
}

# ---------------------------------------------------------------------------
# h. Missing file: exits 0, no crash
# ---------------------------------------------------------------------------

@test "missing file: exits 0 with no output when file does not exist" {
	run_hook "context-injector.sh" \
		"$(_payload Read "$CLAUDE_PROJECT_ROOT/nonexistent/no-such-file.txt")"
	assert_success
	assert_output ""
}

# ---------------------------------------------------------------------------
# i. Multiple rules match
# ---------------------------------------------------------------------------

@test "multiple rules: two *.py rules both appear in output" {
	printf '# pattern: *.py\nPython rule one content.' \
		> "$CLAUDE_PROJECT_ROOT/.omca/rules/py-style.md"
	printf '# pattern: *.py\nPython rule two content.' \
		> "$CLAUDE_PROJECT_ROOT/.omca/rules/py-lint.md"
	touch "$CLAUDE_PROJECT_ROOT/main.py"

	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/main.py")"
	assert_success
	ctx=$(get_context)
	assert echo "$ctx" | grep -q "Python rule one content"
	assert echo "$ctx" | grep -q "Python rule two content"
}

# ---------------------------------------------------------------------------
# j. Rule truncation: content >1000 chars is truncated
# ---------------------------------------------------------------------------

@test "rule truncation: rule body longer than 1000 chars is truncated to 1000 chars" {
	# Build a 1200-char body (all 'x', no newlines after header)
	local long_content
	long_content=$(python3 -c "print('x' * 1200, end='')")
	printf '# pattern: *.py\n%s' "$long_content" \
		> "$CLAUDE_PROJECT_ROOT/.omca/rules/long-rule.md"
	touch "$CLAUDE_PROJECT_ROOT/main.py"

	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/main.py")"
	assert_success
	ctx=$(get_context)
	# The injected rule body must not exceed 1000 chars (extract just the x-sequence)
	local rule_body
	rule_body=$(echo "$ctx" | grep -o 'x\+')
	assert [ "${#rule_body}" -le 1000 ]
}
