#!/usr/bin/env bats
load '../test_helper'

# Claude Code ignores an unknown frontmatter key without an error, and `claude plugin
# validate` does not flag one, so validate-plugin.sh is the only thing that catches a
# misspelled `disallowedTools` before it silently drops an agent's restrictions.

make_fixture() {
	local root="$BATS_TEST_TMPDIR/fixture"
	mkdir -p "$root/agents" "$root/skills/demo"
	printf '%s\n' "$1" > "$root/agents/demo.md"
	printf '%s\n' "$2" > "$root/skills/demo/SKILL.md"
	echo "$root"
}

run_claims() {
	local root="$1"
	run env VALIDATE_PLUGIN_AGENTS_DIR="$root/agents" VALIDATE_PLUGIN_SKILLS_DIR="$root/skills" \
		bash "$CLAUDE_PLUGIN_ROOT/scripts/validate-plugin.sh" --check claims
}

@test "frontmatter keys: a misspelled agent key and an unknown skill key fail" {
	local root
	root=$(make_fixture $'---\nname: demo\ndescription: d\nmodel: opus\ndisallowed_tools:\n  - Agent\n---\nBody' \
		$'---\nname: demo\ndescription: d\nfoo: bar\n---\nBody')
	run_claims "$root"
	assert_output --partial "FAIL: frontmatter keys: the platform ignores these keys"
	assert_output --partial "demo.md:disallowed_tools"
	assert_output --partial "SKILL.md:foo"
}

@test "frontmatter keys: an effort value outside the enum fails" {
	local root
	root=$(make_fixture $'---\nname: demo\ndescription: d\nmodel: opus\neffort: hgih\n---\nBody' \
		$'---\nname: demo\ndescription: d\n---\nBody')
	run_claims "$root"
	assert_output --partial "FAIL: frontmatter keys: effort values outside the platform enum"
	assert_output --partial "demo.md:hgih"
}

@test "frontmatter keys: valid agent and skill frontmatter passes" {
	local root
	root=$(make_fixture $'---\nname: demo\ndescription: d\nmodel: opus\neffort: high\ndisallowedTools:\n  - Agent\n---\nBody' \
		$'---\nname: demo\ndescription: d\ncontext: fork\nagent: demo\neffort: medium\n---\nBody')
	run_claims "$root"
	assert_output --partial "PASS: frontmatter keys: every agent and skill key is one the platform reads"
	assert_output --partial "PASS: frontmatter keys: every effort value is low, medium, high, xhigh, or max"
}
