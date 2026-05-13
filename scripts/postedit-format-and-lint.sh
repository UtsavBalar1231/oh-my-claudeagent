#!/usr/bin/env bash
# PostToolUse Write|Edit: ruff-format servers/*.py and lint scripts/*.sh.
# Registered via args: exec form so the executable path is not shell-parsed.

# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

FILE=$(jq -r '.tool_input.file_path // empty' <<< "${HOOK_INPUT}")

if [[ -z "${FILE}" ]]; then
	exit 0
fi

case "${FILE}" in
	*/servers/*.py)
		uv run --project servers ruff format "${FILE}" 2>/dev/null
		;;
	*/scripts/*.sh)
		OUT=$(shellcheck "${FILE}" 2>&1)
		if [[ -n "${OUT}" ]]; then
			SNIPPET=$(printf '%s\n' "${OUT}" | head -20)
			jq -n --arg ctx "${SNIPPET}" '{
				hookSpecificOutput: {
					hookEventName: "PostToolUse",
					additionalContext: $ctx
				}
			}'
		fi
		;;
	*)
		# Other extensions are out of scope; no-op.
		;;
esac

exit 0
