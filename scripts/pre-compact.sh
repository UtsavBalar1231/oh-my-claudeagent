#!/bin/bash

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
mkdir -p "$STATE_DIR"

CONTEXT_FILE="$STATE_DIR/compaction-context.md"
TMP_CONTEXT="${STATE_DIR}/compaction-context.tmp.$$"

{
	cat <<'TEMPLATE'
# Post-Compaction Context

## Active Mode
TEMPLATE

	if [[ -f "$STATE_DIR/ralph-state.json" ]]; then
		STATUS=$(jq -r '.status // "inactive"' "$STATE_DIR/ralph-state.json" 2>/dev/null)
		if [[ "$STATUS" == "active" ]]; then
			printf '%s\n' "Ralph mode is ACTIVE. The boulder never stops. Continue working on incomplete tasks."
			BOULDER_FILE="$STATE_DIR/boulder.json"
			if [[ -f "$BOULDER_FILE" ]]; then
				printf '\n## Active Plan Reference\n'
				jq -r '.active_plan // "No plan file"' "$BOULDER_FILE" 2>/dev/null || true
			fi
		fi
	fi

	for MODE_FILE in autopilot-state.json ultrawork-state.json team-state.json; do
		if [[ -f "$STATE_DIR/$MODE_FILE" ]]; then
			MODE_NAME="${MODE_FILE%-state.json}"
			STATUS=$(jq -r '.status // "inactive"' "$STATE_DIR/$MODE_FILE" 2>/dev/null)
			if [[ "$STATUS" == "active" ]]; then
				printf '%s\n' "${MODE_NAME} mode is ACTIVE. Continue working."
			fi
		fi
	done

	printf '\n## Pending Tasks\n'

	if [[ -f "$STATE_DIR/team-state.json" ]]; then
		PENDING=$(jq -r '[.tasks[]? | select(.status == "pending" or .status == "claimed") | "- \(.name // .id): \(.status)"] | join("\n")' "$STATE_DIR/team-state.json" 2>/dev/null || echo "")
		if [[ -n "$PENDING" ]]; then
			printf '%s\n' "$PENDING"
		else
			printf '%s\n' "No pending team tasks."
		fi
	else
		printf '%s\n' "No team state found."
	fi
} >"$TMP_CONTEXT"

if ! mv "$TMP_CONTEXT" "$CONTEXT_FILE" 2>/dev/null; then
	rm -f "$TMP_CONTEXT"
fi

exit 0
