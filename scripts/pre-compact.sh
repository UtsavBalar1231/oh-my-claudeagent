#!/bin/bash

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
STATE_DIR="${PROJECT_ROOT}/.omca/state"
mkdir -p "$STATE_DIR"

CONTEXT_FILE="$STATE_DIR/compaction-context.md"

cat >"$CONTEXT_FILE" <<'TEMPLATE'
# Post-Compaction Context

## Active Mode
TEMPLATE

if [[ -f "$STATE_DIR/ralph-state.json" ]]; then
	STATUS=$(jq -r '.status // "inactive"' "$STATE_DIR/ralph-state.json" 2>/dev/null)
	if [[ "$STATUS" == "active" ]]; then
		echo "Ralph mode is ACTIVE. The boulder never stops. Continue working on incomplete tasks." >>"$CONTEXT_FILE"
		BOULDER_FILE="$STATE_DIR/boulder.json"
		if [[ -f "$BOULDER_FILE" ]]; then
			echo "" >>"$CONTEXT_FILE"
			echo "## Active Plan Reference" >>"$CONTEXT_FILE"
			jq -r '.planFile // "No plan file"' "$BOULDER_FILE" >>"$CONTEXT_FILE" 2>/dev/null || true
		fi
	fi
fi

for MODE_FILE in autopilot-state.json ultrawork-state.json team-state.json; do
	if [[ -f "$STATE_DIR/$MODE_FILE" ]]; then
		MODE_NAME="${MODE_FILE%-state.json}"
		STATUS=$(jq -r '.status // "inactive"' "$STATE_DIR/$MODE_FILE" 2>/dev/null)
		if [[ "$STATUS" == "active" ]]; then
			echo "${MODE_NAME} mode is ACTIVE. Continue working." >>"$CONTEXT_FILE"
		fi
	fi
done

echo "" >>"$CONTEXT_FILE"
echo "## Pending Tasks" >>"$CONTEXT_FILE"

if [[ -f "$STATE_DIR/team-state.json" ]]; then
	PENDING=$(jq -r '[.tasks[]? | select(.status == "pending" or .status == "claimed") | "- \(.name // .id): \(.status)"] | join("\n")' "$STATE_DIR/team-state.json" 2>/dev/null || echo "")
	if [[ -n "$PENDING" ]]; then
		echo "$PENDING" >>"$CONTEXT_FILE"
	else
		echo "No pending team tasks." >>"$CONTEXT_FILE"
	fi
else
	echo "No team state found." >>"$CONTEXT_FILE"
fi

exit 0
