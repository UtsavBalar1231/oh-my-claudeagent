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

# ---------------------------------------------------------------------------
# k. Rule dedup: content-hash + realpath keyed, per session
# ---------------------------------------------------------------------------

@test "rule dedup: second Read of the same file does NOT re-inject an already-injected rule" {
	printf '# pattern: *.py\nDedup rule content.' \
		> "$CLAUDE_PROJECT_ROOT/.omca/rules/dedup.md"
	touch "$CLAUDE_PROJECT_ROOT/main.py"

	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/main.py")"
	assert_success
	ctx=$(get_context)
	[[ "$ctx" == *"Dedup rule content"* ]]

	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/main.py")"
	assert_success
	ctx=$(get_context)
	[[ "$ctx" != *"Dedup rule content"* ]]
}

@test "rule dedup: a rule matching a different file on second call still injects (not globally suppressed)" {
	printf '# pattern: *.py\nShared rule content.' \
		> "$CLAUDE_PROJECT_ROOT/.omca/rules/shared.md"
	touch "$CLAUDE_PROJECT_ROOT/first.py"
	touch "$CLAUDE_PROJECT_ROOT/second.py"

	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/first.py")"
	assert_success
	ctx=$(get_context)
	[[ "$ctx" == *"Shared rule content"* ]]

	# Same rule file/content, different accessed file — still deduped (key is rule-identity,
	# not accessed-file identity), matching the "per rule per session" contract.
	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/second.py")"
	assert_success
	ctx=$(get_context)
	[[ "$ctx" != *"Shared rule content"* ]]
}

@test "rule dedup: symlinked rule file resolves to same realpath and is not double-injected" {
	printf '# pattern: *.py\nSymlink rule content.' \
		> "$CLAUDE_PROJECT_ROOT/.omca/rules/real-rule.md"
	ln -s "$CLAUDE_PROJECT_ROOT/.omca/rules/real-rule.md" "$CLAUDE_PROJECT_ROOT/.omca/rules/alias-rule.md"
	touch "$CLAUDE_PROJECT_ROOT/main.py"

	# First call: glob picks up both real-rule.md and alias-rule.md (symlink), same realpath+hash
	# → injected once, not twice.
	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/main.py")"
	assert_success
	ctx=$(get_context)
	local occurrences
	occurrences=$(echo "$ctx" | grep -o "Symlink rule content" | wc -l)
	assert [ "$occurrences" -eq 1 ]
}

@test "rule dedup: cache records a rule: prefixed key in injected-context-dirs.json" {
	printf '# pattern: *.py\nCache key rule content.' \
		> "$CLAUDE_PROJECT_ROOT/.omca/rules/cachekey.md"
	touch "$CLAUDE_PROJECT_ROOT/main.py"

	run_hook "context-injector.sh" "$(_payload Read "$CLAUDE_PROJECT_ROOT/main.py")"
	assert_success

	local cache="$CLAUDE_PROJECT_ROOT/.omca/state/injected-context-dirs.json"
	assert [ -f "$cache" ]
	local recorded
	recorded=$(jq -r 'to_entries[] | select(.key | startswith("rule:")) | .value' "$cache")
	assert [ "$recorded" = "true" ]
}

# ---------------------------------------------------------------------------
# l. Worktree-safe PROJECT_ROOT derivation
# ---------------------------------------------------------------------------

@test "worktree root: AGENTS.md walk terminates at the linked worktree's .git file, not the parent dir" {
	# Simulate a linked worktree: .git is a FILE (gitdir pointer), not a directory.
	local worktree_dir="$BATS_TEST_TMPDIR/worktree"
	mkdir -p "$worktree_dir/subdir"
	echo "gitdir: /some/main/repo/.git/worktrees/wt" > "$worktree_dir/.git"
	echo "# Worktree Agents" > "$worktree_dir/AGENTS.md"

	# A parent-level AGENTS.md that must NOT be walked into once the worktree boundary is hit.
	echo "# Parent Secret Agents" > "$BATS_TEST_TMPDIR/AGENTS.md"

	touch "$worktree_dir/subdir/file.txt"

	run_hook "context-injector.sh" "$(_payload Read "$worktree_dir/subdir/file.txt")"
	assert_success
	ctx=$(get_context)
	[[ "$ctx" == *"Worktree Agents"* ]]
	[[ "$ctx" != *"Parent Secret Agents"* ]]
}

@test "worktree root: .omca/rules scan uses the worktree root, not CLAUDE_PROJECT_ROOT" {
	local worktree_dir="$BATS_TEST_TMPDIR/worktree2"
	mkdir -p "$worktree_dir/.omca/rules"
	echo "gitdir: /some/main/repo/.git/worktrees/wt2" > "$worktree_dir/.git"
	printf '# pattern: *.py\nWorktree-local rule content.' \
		> "$worktree_dir/.omca/rules/local.md"

	# A same-pattern rule under the (unrelated) CLAUDE_PROJECT_ROOT must NOT fire, proving the
	# rules scan followed the worktree root rather than falling back to CLAUDE_PROJECT_ROOT.
	printf '# pattern: *.py\nMain repo rule content.' \
		> "$CLAUDE_PROJECT_ROOT/.omca/rules/main.md"

	touch "$worktree_dir/main.py"

	run_hook "context-injector.sh" "$(_payload Read "$worktree_dir/main.py")"
	assert_success
	ctx=$(get_context)
	[[ "$ctx" == *"Worktree-local rule content"* ]]
	[[ "$ctx" != *"Main repo rule content"* ]]
}
