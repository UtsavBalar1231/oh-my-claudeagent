#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

# Detect OMCA mode activation via slash-command name (UserPromptExpansion).
# command_name is available directly on this event — no text-matching needed.
# Complements keyword-detector.sh (UserPromptSubmit), which handles free-text triggers.

COMMAND_NAME=$(jq -r '.command_name // ""' <<< "${HOOK_INPUT}")

# Ignore non-OMCA commands immediately
if [[ -z "${COMMAND_NAME}" ]] || [[ "${COMMAND_NAME}" != oh-my-claudeagent:* ]]; then
	exit 0
fi

# Map slash-command name to mode. Only mode-triggering commands are handled;
# all other oh-my-claudeagent:* commands exit 0 silently.
MODE=""
case "${COMMAND_NAME}" in
	oh-my-claudeagent:ralph)           MODE="ralph" ;;
	oh-my-claudeagent:ultrawork)       MODE="ultrawork" ;;
	oh-my-claudeagent:ulw-loop)        MODE="ultrawork" ;;
	oh-my-claudeagent:handoff)         MODE="handoff" ;;
	oh-my-claudeagent:stop-continuation) MODE="stop-continuation" ;;
	*)                                 exit 0 ;;
esac

# CURRENT_SESSION is referenced by mode_already_announced / mark_mode_announced in common.sh
# shellcheck disable=SC2034
CURRENT_SESSION=$(resolve_session_id)

# Session-aware re-announce suppression: don't fire twice in the same session.
if mode_already_announced "${MODE}"; then
	exit 0
fi

mark_mode_announced "${MODE}"

# Emit banner mapping mode to its activation message.
BANNER=""
case "${MODE}" in
	ralph)             BANNER="[RALPH MODE ACTIVATED via slash command] Persistence mode — do not stop until verified complete." ;;
	ultrawork)         BANNER="[ULTRAWORK MODE ACTIVATED via slash command] Maximum parallel execution." ;;
	handoff)           BANNER="[HANDOFF MODE ACTIVATED via slash command] Create session handoff summary for new-session continuity." ;;
	stop-continuation) BANNER="[STOP CONTINUATION ACTIVATED via slash command] Halt all automated work — ralph and boulder state." ;;
	*)                 exit 0 ;;
esac

emit_context "UserPromptExpansion" "${BANNER}"
