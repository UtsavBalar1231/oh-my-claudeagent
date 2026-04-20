#!/bin/bash
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

LOG_DIR="${HOOK_LOG_DIR}"

NOTIFICATION_TYPE=$(jq -r '.type // "notification"' <<< "${HOOK_INPUT}")
MESSAGE=$(jq -r '.message // "Claude Code needs attention"' <<< "${HOOK_INPUT}")
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
		# Strip newlines — osascript breaks on multiline strings in display notification
		local safe_msg safe_title
		safe_msg=$(printf '%s' "${message}" | tr '\n' ' ' | sed 's/["\\]/\\&/g')
		safe_title=$(printf '%s' "${title}" | tr '\n' ' ' | sed 's/["\\]/\\&/g')
		osascript -e "display notification \"${safe_msg}\" with title \"${safe_title}\"" 2>/dev/null || true
		return 0
	fi

	if command -v notify-send &>/dev/null; then
		local safe_notify_msg safe_notify_title
		safe_notify_msg=$(printf '%s' "${message}" | tr '\n' ' ')
		safe_notify_title=$(printf '%s' "${title}" | tr '\n' ' ')
		notify-send "${safe_notify_title}" "${safe_notify_msg}" 2>/dev/null || true
		return 0
	fi

	if command -v zenity &>/dev/null; then
		local safe_zenity_text
		safe_zenity_text=$(printf '%s: %s' "${title}" "${message}" | tr '\n' ' ')
		zenity --notification --text="${safe_zenity_text}" 2>/dev/null || true
		return 0
	fi

	if [[ -f /proc/version ]] && grep -qi microsoft /proc/version 2>/dev/null; then
		local safe_ps_title safe_ps_msg
		safe_ps_title=$(printf '%s' "${title}" | sed "s/'/''/g" | tr '\n' ' ')
		safe_ps_msg=$(printf '%s' "${message}" | sed "s/'/''/g" | tr '\n' ' ')
		powershell.exe -Command "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; \$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); \$textNodes = \$template.GetElementsByTagName('text'); \$textNodes.Item(0).AppendChild(\$template.CreateTextNode('${safe_ps_title}')); \$textNodes.Item(1).AppendChild(\$template.CreateTextNode('${safe_ps_msg}')); \$toast = [Windows.UI.Notifications.ToastNotification]::new(\$template); [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Claude Code').Show(\$toast)" 2>/dev/null || true
		return 0
	fi

	echo -e "\a" >&2 || true
	return 0
}

send_notification "${TITLE}" "${MESSAGE}"

LOG_FILE="${LOG_DIR}/notifications.jsonl"
jq -nc --arg type "${NOTIFICATION_TYPE}" --arg title "${TITLE}" --arg msg "${MESSAGE}" --arg ts "$(date -Iseconds || true)" \
	'{event: "notification", type: $type, title: $title, message: $msg, timestamp: $ts}' >>"${LOG_FILE}"

exit 0
