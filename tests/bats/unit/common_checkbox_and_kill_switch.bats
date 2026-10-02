#!/usr/bin/env bats
# Unit tests for hook_is_disabled in scripts/lib/common.sh

load '../test_helper'

@test "hook_is_disabled: matches a name in a comma-separated OMCA_DISABLED_HOOKS list" {
	run bash -c "source '${CLAUDE_PLUGIN_ROOT}/scripts/lib/common.sh' && OMCA_DISABLED_HOOKS='final-verification-evidence,other-hook' hook_is_disabled 'final-verification-evidence'"
	assert_success
}

@test "hook_is_disabled: matches a name in a whitespace-separated OMCA_DISABLED_HOOKS list" {
	run bash -c "source '${CLAUDE_PLUGIN_ROOT}/scripts/lib/common.sh' && OMCA_DISABLED_HOOKS='final-verification-evidence other-hook' hook_is_disabled 'final-verification-evidence'"
	assert_success
}

@test "hook_is_disabled: does not match a name absent from the list" {
	run bash -c "source '${CLAUDE_PLUGIN_ROOT}/scripts/lib/common.sh' && OMCA_DISABLED_HOOKS='other-hook' hook_is_disabled 'final-verification-evidence'"
	assert_failure
}

@test "hook_is_disabled: unset OMCA_DISABLED_HOOKS returns 1" {
	run bash -c "source '${CLAUDE_PLUGIN_ROOT}/scripts/lib/common.sh' && unset OMCA_DISABLED_HOOKS; hook_is_disabled 'final-verification-evidence'"
	assert_failure
}
