#!/usr/bin/env bats
# Workflow-contract test: keeps `just ci`'s recipe chain in sync with .github/workflows/ci.yml,
# and keeps .github/workflows/release.yml's pre-release gate set in sync with the same commands.
#
# The `just ci` chain is DERIVED from the justfile at test runtime (see _resolve_leaf_steps
# below), so adding a new step to the `ci:` recipe without a matching entry in _step_pattern
# fails the "every leaf step has a pinned pattern" test below: that is the whole point.
#
# Pinned pairing table (leaf recipe -> substring expected in ci.yml). A pin is needed wherever
# ci.yml invokes the same underlying command differently than the justfile recipe body does (for
# example, a globally installed tool instead of `uv run --project servers`). Each pin is also
# asserted to be an actual substring of the recipe's own body, so a pin cannot silently drift
# from the real command, only from CI's coverage of it.
#
# | leaf recipe | ci.yml pattern                                                    | why it differs from the recipe body |
# |-------------|--------------------------------------------------------------------|--------------------------------------|
# | fmt-check   | ruff format --check servers/                                        | CI installs ruff globally (`uv tool install ruff`), not via `uv run --project servers` |
# | lint-shell  | shellcheck scripts/*.sh                                             | identical invocation |
# | lint-python | ruff check servers/                                                 | same normalization as fmt-check |
# | test        | bash scripts/validate-plugin.sh --check claims --check hooks       | identical invocation |
# | test-bats   | tests/bats/bats-core/bin/bats tests/bats/hooks/ tests/bats/unit/    | identical invocation; must cover BOTH suite dirs |
# | test-pytest | uv run --project servers pytest servers/tests/                     | identical invocation modulo trailing -v/--tb flags |
# | test-mcp    | bash scripts/validate-plugin.sh --check mcp                        | identical invocation |

load '../test_helper'

# ---- justfile recipe parsing helpers ----

# Print the raw (unsplit) dependency-list portion of a recipe's header line, if any.
_recipe_deps_raw() {
	local name="$1" file="$2"
	awk -v n="$name" '$0 ~ "^" n ":" { print substr($0, index($0, ":") + 1); exit }' "$file"
}

# Print each non-comment, non-blank, tab-indented body line belonging to a recipe.
_recipe_body() {
	local name="$1" file="$2"
	awk -v n="$name" '
		$0 ~ "^" n ":" { active = 1; next }
		active && /^\t/ {
			line = $0
			sub(/^\t/, "", line)
			if (line !~ /^#/ && line !~ /^[ \t]*$/) print line
			next
		}
		active { active = 0 }
	' "$file"
}

# Recursively expand a recipe name to its leaf steps: recipes with a real body are leaves;
# recipes with only a dependency list (no body, e.g. `lint: lint-shell lint-python`) expand
# into their dependencies instead.
_resolve_leaf_steps() {
	local name="$1" file="$2"
	local body
	body="$(_recipe_body "$name" "$file")"
	if [[ -n "$body" ]]; then
		echo "$name"
		return
	fi
	local deps
	deps=$(_recipe_deps_raw "$name" "$file" | tr -s ' \t' ' ')
	if [[ -z "${deps// /}" ]]; then
		echo "$name"
		return
	fi
	local d
	for d in $deps; do
		[[ -n "$d" && "$d" != *=* ]] || continue
		_resolve_leaf_steps "$d" "$file"
	done
}

# Pinned leaf-step -> ci.yml coverage pattern table (see header comment for rationale).
_step_pattern() {
	case "$1" in
		fmt-check) echo "ruff format --check servers/" ;;
		lint-shell) echo "shellcheck scripts/*.sh" ;;
		lint-python) echo "ruff check servers/" ;;
		test) echo "bash scripts/validate-plugin.sh --check claims --check hooks" ;;
		test-bats) echo "tests/bats/bats-core/bin/bats tests/bats/hooks/ tests/bats/unit/" ;;
		test-pytest) echo "uv run --project servers pytest servers/tests/" ;;
		test-mcp) echo "bash scripts/validate-plugin.sh --check mcp" ;;
		*) echo "" ;;
	esac
}

@test "just ci recipe chain resolves to the expected leaf steps" {
	local steps
	steps=$(_resolve_leaf_steps ci "$CLAUDE_PLUGIN_ROOT/justfile" | sort -u | tr '\n' ' ')
	[ "$steps" = "fmt-check lint-python lint-shell test test-bats test-mcp test-pytest " ]
}

@test "every just ci leaf step has a pinned ci.yml coverage pattern" {
	local step pattern missing=""
	for step in $(_resolve_leaf_steps ci "$CLAUDE_PLUGIN_ROOT/justfile" | sort -u); do
		pattern=$(_step_pattern "$step")
		[[ -n "$pattern" ]] || missing="$missing $step"
	done
	[ -z "$missing" ]
}

@test "each pinned pattern is a real substring of its recipe's own body" {
	local step pattern body mismatched=""
	for step in $(_resolve_leaf_steps ci "$CLAUDE_PLUGIN_ROOT/justfile" | sort -u); do
		pattern=$(_step_pattern "$step")
		body=$(_recipe_body "$step" "$CLAUDE_PLUGIN_ROOT/justfile")
		[[ "$body" == *"$pattern"* ]] || mismatched="$mismatched $step"
	done
	[ -z "$mismatched" ]
}

@test "ci.yml covers every just ci leaf step's pinned pattern" {
	local step pattern uncovered=""
	for step in $(_resolve_leaf_steps ci "$CLAUDE_PLUGIN_ROOT/justfile" | sort -u); do
		pattern=$(_step_pattern "$step")
		grep -qF -- "$pattern" "$CLAUDE_PLUGIN_ROOT/.github/workflows/ci.yml" || uncovered="$uncovered $step"
	done
	[ -z "$uncovered" ]
}

@test "negative sanity: removing the test-mcp job from a ci.yml copy makes coverage fail" {
	local fixture="$BATS_TEST_TMPDIR/ci-missing-mcp.yml"
	# Drop the entire test-mcp job block (its header through the line before the next
	# top-level job) from an IN-MEMORY copy: the real ci.yml is never touched.
	awk '
		/^  test-mcp:/ { skip = 1; next }
		skip && /^  [a-zA-Z_-]+:/ { skip = 0 }
		!skip { print }
	' "$CLAUDE_PLUGIN_ROOT/.github/workflows/ci.yml" > "$fixture"

	run grep -qF -- "$(_step_pattern test-mcp)" "$fixture"
	[ "$status" -ne 0 ]

	# Sanity check: the same pattern IS present in the real, unmodified file.
	run grep -qF -- "$(_step_pattern test-mcp)" "$CLAUDE_PLUGIN_ROOT/.github/workflows/ci.yml"
	[ "$status" -eq 0 ]
}

@test "release.yml runs the claims+hooks validate gate" {
	grep -qF -- "$(_step_pattern test)" "$CLAUDE_PLUGIN_ROOT/.github/workflows/release.yml"
}

@test "release.yml runs the bats gate covering both suite dirs" {
	grep -qF -- "$(_step_pattern test-bats)" "$CLAUDE_PLUGIN_ROOT/.github/workflows/release.yml"
}

@test "release.yml runs the pytest gate" {
	grep -qF -- "$(_step_pattern test-pytest)" "$CLAUDE_PLUGIN_ROOT/.github/workflows/release.yml"
}

@test "release.yml's release job needs the validate, test-bats, and test-pytest gates" {
	local needs_line
	needs_line=$(awk '/^  release:/ { found = 1 } found && /needs:/ { print; exit }' \
		"$CLAUDE_PLUGIN_ROOT/.github/workflows/release.yml")
	[[ "$needs_line" == *"validate"* ]]
	[[ "$needs_line" == *"test-bats"* ]]
	[[ "$needs_line" == *"test-pytest"* ]]
}
