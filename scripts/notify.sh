#!/bin/bash

INPUT=$(cat)

NOTIFICATION_TYPE=$(echo "${INPUT}" | jq -r '.type // "notification"' 2>/dev/null)
MESSAGE=$(echo "${INPUT}" | jq -r '.message // "Claude Code needs attention"' 2>/dev/null)
TITLE="oh-my-claudeagent"

case "${NOTIFICATION_TYPE}" in
idle_prompt)
	TITLE="Claude Code - Waiting"
	MESSAGE="Claude Code is waiting for your input"
	;;
permission_prompt)
	TITLE="Claude Code - Permission Required"
	MESSAGE="Claude Code needs permission to proceed"
	;;
*)
	;;
esac

send_notification() {
	local title="$1"
	local message="$2"

	if command -v terminal-notifier &>/dev/null; then
		terminal-notifier -title "${title}" -message "${message}" -sound default 2>/dev/null || true
		return 0
	fi

	if command -v osascript &>/dev/null; then
		osascript -e "display notification \"$(printf '%s' "${message}" | sed 's/["\\]/\\&/g')\" with title \"$(printf '%s' "${title}" | sed 's/["\\]/\\&/g')\"" 2>/dev/null || true
		return 0
	fi

	if command -v notify-send &>/dev/null; then
		notify-send "${title}" "${message}" 2>/dev/null || true
		return 0
	fi

	if command -v zenity &>/dev/null; then
		zenity --notification --text="${title}: ${message}" 2>/dev/null || true
		return 0
	fi

	if [[ -f /proc/version ]] && grep -qi microsoft /proc/version 2>/dev/null; then
		powershell.exe -Command "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; \$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); \$textNodes = \$template.GetElementsByTagName('text'); \$textNodes.Item(0).AppendChild(\$template.CreateTextNode('${title}')); \$textNodes.Item(1).AppendChild(\$template.CreateTextNode('${message}')); \$toast = [Windows.UI.Notifications.ToastNotification]::new(\$template); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Claude Code').Show(\$toast)" 2>/dev/null || true
		return 0
	fi

	echo -e "\a" >&2 || true
	return 0
}

send_notification "${TITLE}" "${MESSAGE}"

PROJECT_ROOT="${CLAUDE_PROJECT_ROOT:-$(pwd)}"
LOG_DIR="${PROJECT_ROOT}/.omca/logs"
mkdir -p "${LOG_DIR}"

LOG_FILE="${LOG_DIR}/notifications.jsonl"
jq -nc --arg type "${NOTIFICATION_TYPE}" --arg title "${TITLE}" --arg msg "${MESSAGE}" --arg ts "$(date -Iseconds || true)" \
	'{event: "notification", type: $type, title: $title, message: $msg, timestamp: $ts}' >>"${LOG_FILE}"

exit 0
