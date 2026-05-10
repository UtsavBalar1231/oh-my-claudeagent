#!/bin/bash

# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"

PROJECT_ROOT="${HOOK_PROJECT_ROOT}"
STATE_DIR="${HOOK_STATE_DIR}"
LOG_DIR="${HOOK_LOG_DIR}"

HOOK_EVENT_NAME=$(jq -r '.hook_event_name // ""' <<< "${HOOK_INPUT}")
TIMESTAMP=$(date -Iseconds)

build_watch_paths_json() {
	local repo_root="$1"

	jq -nc --arg root "${repo_root}" '
		[
			$root + "/.claude/settings.json",
			$root + "/.mcp.json",
			$root + "/AGENTS.md",
			$root + "/CLAUDE.md",
			$root + "/hooks/hooks.json",
			$root + "/.claude-plugin/plugin.json",
			$root + "/settings.json"
		]
	'
}

resolve_repo_root() {
	local candidate="$1"
	local repo_root=""

	if [[ -z "${candidate}" ]] || [[ "${candidate}" == "null" ]]; then
		candidate="${PROJECT_ROOT}"
	fi

	if [[ ! -d "${candidate}" ]]; then
		candidate="$(dirname "${candidate}")"
	fi

	repo_root=$(git -C "${candidate}" rev-parse --show-toplevel 2>/dev/null) || true
	if [[ -n "${repo_root}" ]]; then
		printf '%s' "${repo_root}"
		return 0
	fi

	printf '%s' "${PROJECT_ROOT}"
}

write_repo_state() {
	local event_name="$1"
	local repo_root="$2"
	local active_cwd="$3"
	local old_cwd="$4"
	local changed_path="$5"
	local changed_event="$6"
	local watch_paths_json="$7"
	local state_file="${STATE_DIR}/repo-state.json"
	local tmp_file

	tmp_file=$(mktemp)
	jq -n \
		--arg event_name "${event_name}" \
		--arg repo_root "${repo_root}" \
		--arg active_cwd "${active_cwd}" \
		--arg old_cwd "${old_cwd}" \
		--arg changed_path "${changed_path}" \
		--arg changed_event "${changed_event}" \
		--arg timestamp "${TIMESTAMP}" \
		--argjson watch_paths "${watch_paths_json}" '
		{
			repoRoot: $repo_root,
			activeCwd: $active_cwd,
			lastEvent: $event_name,
			updatedAt: $timestamp,
			watchPaths: $watch_paths
		}
		| if $old_cwd != "" then .oldCwd = $old_cwd else . end
		| if $changed_path != "" then .changedFile = {path: $changed_path, event: $changed_event} else . end
	' >"${tmp_file}" && mv "${tmp_file}" "${state_file}"

	jq -nc \
		--arg event_name "${event_name}" \
		--arg repo_root "${repo_root}" \
		--arg active_cwd "${active_cwd}" \
		--arg old_cwd "${old_cwd}" \
		--arg changed_path "${changed_path}" \
		--arg changed_event "${changed_event}" \
		--arg timestamp "${TIMESTAMP}" \
		--argjson watch_paths "${watch_paths_json}" '
		{
			event: "repo_state_refresh",
			hook_event_name: $event_name,
			repo_root: $repo_root,
			active_cwd: $active_cwd,
			timestamp: $timestamp,
			watchPaths: $watch_paths
		}
		| if $old_cwd != "" then .old_cwd = $old_cwd else . end
		| if $changed_path != "" then .changed_file = {path: $changed_path, event: $changed_event} else . end
	' >>"${LOG_DIR}/repo-state.jsonl"
}

handle_task_created() {
	local task_id task_subject task_description teammate_name team_name

	task_id=$(jq -r '.task_id // ""' <<< "${HOOK_INPUT}")
	task_subject=$(jq -r '.task_subject // ""' <<< "${HOOK_INPUT}")
	task_description=$(jq -r '.task_description // ""' <<< "${HOOK_INPUT}")
	teammate_name=$(jq -r '.teammate_name // ""' <<< "${HOOK_INPUT}")
	team_name=$(jq -r '.team_name // ""' <<< "${HOOK_INPUT}")

	jq -nc \
		--arg task_id "${task_id}" \
		--arg task_subject "${task_subject}" \
		--arg task_description "${task_description}" \
		--arg teammate_name "${teammate_name}" \
		--arg team_name "${team_name}" \
		--arg timestamp "${TIMESTAMP}" '
		{
			event: "task_created",
			timestamp: $timestamp,
			task_id: $task_id,
			task_subject: $task_subject
		}
		| if $task_description != "" then .task_description = $task_description else . end
		| if $teammate_name != "" then .teammate_name = $teammate_name else . end
		| if $team_name != "" then .team_name = $team_name else . end
	' >>"${LOG_DIR}/tasks.jsonl"

	exit 0
}

handle_repo_refresh() {
	local active_cwd old_cwd changed_path changed_event repo_root watch_paths_json output_json

	case "${HOOK_EVENT_NAME}" in
	CwdChanged)
		old_cwd=$(jq -r '.old_cwd // ""' <<< "${HOOK_INPUT}")
		active_cwd=$(jq -r '.new_cwd // .cwd // ""' <<< "${HOOK_INPUT}")
		changed_path=""
		changed_event=""
		;;
	FileChanged)
		active_cwd=$(jq -r '.cwd // ""' <<< "${HOOK_INPUT}")
		old_cwd=""
		changed_path=$(jq -r '.file_path // ""' <<< "${HOOK_INPUT}")
		changed_event=$(jq -r '.event // ""' <<< "${HOOK_INPUT}")
		if [[ -z "${active_cwd}" ]] && [[ -n "${changed_path}" ]]; then
			active_cwd="$(dirname "${changed_path}")"
		fi
		;;
	*)
		log_hook_error "Unsupported repo refresh event '${HOOK_EVENT_NAME}'" "lifecycle-state.sh"
		exit 0
		;;
	esac

	repo_root=$(resolve_repo_root "${active_cwd}")
	watch_paths_json=$(build_watch_paths_json "${repo_root}")
	write_repo_state "${HOOK_EVENT_NAME}" "${repo_root}" "${active_cwd}" "${old_cwd}" "${changed_path}" "${changed_event}" "${watch_paths_json}"

	# watchPaths is documented for both CwdChanged and FileChanged hooks (hooks.md §CwdChanged, §FileChanged).
	# Returning it here dynamically updates the platform's file-watch list to key project config files.
	# Decision: KEEP — field is live and tested against hooks.md. See .omca/notes/watchpaths-decision.md.
	output_json=$(jq -nc --arg event_name "${HOOK_EVENT_NAME}" --argjson watch_paths "${watch_paths_json}" '{hookSpecificOutput: {hookEventName: $event_name, watchPaths: $watch_paths}}')
	printf '%s\n' "${output_json}"
	exit 0
}

handle_worktree_create() {
	# Registration rationale: this handler is NOT a no-op. It writes
	# .omca/state/worktrees/{name}.json (the tracking file) and appends to
	# worktrees.jsonl. handle_worktree_remove depends on the tracking file for
	# cleanup — deregistering WorktreeCreate would silently break WorktreeRemove.
	local name repo_root worktrees_root worktree_path tracking_file tmp_file

	name=$(jq -r '.name // ""' <<< "${HOOK_INPUT}")
	if [[ -z "${name}" ]]; then
		echo "WorktreeCreate hook requires a non-empty name" >&2
		exit 1
	fi

	repo_root=$(resolve_repo_root "$(jq -r '.cwd // ""' <<< "${HOOK_INPUT}")")

	# Guard: git worktree requires a git repository. Non-git directories are not
	# supported — log and fail clearly rather than letting git produce a cryptic error.
	if ! git -C "${repo_root}" rev-parse --show-toplevel >/dev/null 2>&1; then
		echo "WorktreeCreate: not a git repository at ${repo_root}; worktree isolation requires git" >&2
		exit 1
	fi

	worktrees_root="${repo_root}/.claude/worktrees"
	worktree_path="${worktrees_root}/${name}"

	mkdir -p "${worktrees_root}" "${STATE_DIR}/worktrees"

	if [[ -e "${worktree_path}" ]]; then
		echo "WorktreeCreate target already exists: ${worktree_path}" >&2
		exit 1
	fi

	if ! git -C "${repo_root}" worktree add --detach "${worktree_path}" HEAD >&2; then
		echo "WorktreeCreate failed for ${worktree_path}" >&2
		exit 1
	fi

	tracking_file="${STATE_DIR}/worktrees/${name}.json"
	tmp_file=$(mktemp)
	jq -n \
		--arg name "${name}" \
		--arg repo_root "${repo_root}" \
		--arg worktree_path "${worktree_path}" \
		--arg timestamp "${TIMESTAMP}" '
		{
			name: $name,
			repoRoot: $repo_root,
			worktreePath: $worktree_path,
			path: $worktree_path,
			createdAt: $timestamp
		}
	' >"${tmp_file}" && mv "${tmp_file}" "${tracking_file}"

	jq -nc --arg name "${name}" --arg worktree_path "${worktree_path}" --arg timestamp "${TIMESTAMP}" \
		'{event: "worktree_create", name: $name, worktreePath: $worktree_path, timestamp: $timestamp}' >>"${LOG_DIR}/worktrees.jsonl"

	printf '%s\n' "${worktree_path}"
	exit 0
}

handle_worktree_remove() {
	local name tracking_file worktree_path

	# Platform sends `.worktree_path` (not `.name`) per hooks.md WorktreeRemove section.
	# Derive name from basename for backward-compatible tracking-file rename pattern.
	worktree_path=$(jq -r '.worktree_path // ""' <<< "${HOOK_INPUT}")
	if [[ -z "${worktree_path}" ]]; then
		echo "WorktreeRemove hook requires a non-empty worktree_path" >&2
		exit 1
	fi
	name=$(basename "${worktree_path}")

	tracking_file="${STATE_DIR}/worktrees/${name}.json"
	if [[ -f "${tracking_file}" ]]; then
		rm -f "${tracking_file}"
	fi

	jq -nc --arg name "${name}" --arg worktree_path "${worktree_path}" --arg timestamp "${TIMESTAMP}" \
		'{event: "worktree_remove", name: $name, worktreePath: $worktree_path, timestamp: $timestamp}' >>"${LOG_DIR}/worktrees.jsonl"

	exit 0
}

case "${HOOK_EVENT_NAME}" in
TaskCreated)
	handle_task_created
	;;
CwdChanged | FileChanged)
	handle_repo_refresh
	;;
WorktreeCreate)
	handle_worktree_create
	;;
WorktreeRemove)
	handle_worktree_remove
	;;
*)
	log_hook_error "Unsupported lifecycle event '${HOOK_EVENT_NAME}'" "lifecycle-state.sh"
	exit 0
	;;
esac
