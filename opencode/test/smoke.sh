#!/usr/bin/env bash
set -euo pipefail
shopt -s inherit_errexit

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
tmp=$(mktemp -d)
server=
cleanup() {
  if [[ -n ${server} ]]; then
    kill -- "-${server}" 2>/dev/null || true
    wait "${server}" 2>/dev/null || true
  fi
  rm -rf "${tmp}"
}
trap cleanup EXIT

pass() { echo "PASS $1"; }
fail() {
  echo "FAIL $1: $2"
  exit 1
}

api() {
  local method=$1 path=$2 dir=$3 enc
  shift 3
  enc=$(jq -rn --arg d "${dir}" '$d|@uri')
  curl -s -u "opencode:${OPENCODE_PASSWORD}" -X "${method}" -H 'content-type: application/json' "$@" \
    "${base}${path}?location%5Bdirectory%5D=${enc}" || true
}

check() {
  jq -e "$2" <<<"$3" >/dev/null || fail "$1" "$(jq -c "$4" <<<"$3" | head -c 400)"
}

poll() {
  local name=$1 timeout=$2 filter=$3 deadline=$((SECONDS + $2))
  shift 3
  while ((SECONDS < deadline)); do
    out=$(api GET "$@")
    if jq -e "${filter}" <<<"${out}" >/dev/null 2>&1; then return; fi
    sleep 0.5
  done
  fail "${name}" "timed out after ${timeout}s, last response: ${out:0:400}"
}

commit() { git -C "$1" -c user.name=omca -c user.email=omca@localhost commit -q --allow-empty -m "$2"; }

workspace() {
  mkdir -p "$1/.opencode"
  printf '%s\n' "$2" >"$1/.opencode/opencode.jsonc"
  git -C "$1" init -q
  git -C "$1" add -A
  commit "$1" one
  commit "$1" two
}

local_plugin() {
  jq -cn --arg pkg "${repo}/opencode" --arg opus "$1" '{plugins: [{package: $pkg, options: {models: {opus: $opus}}}]}'
}

A=${tmp}/a B=${tmp}/b C=${tmp}/c clone=${tmp}/clone log=${tmp}/server.log
workspace "${A}" "$(local_plugin anthropic/claude-opus-5-5)"
workspace "${B}" "$(local_plugin bad)"
mkdir -p "${clone}"
git -C "${repo}" ls-files -co --exclude-standard -z |
  rsync -a --from0 --ignore-missing-args --files-from=- "${repo}/" "${clone}/"
git -C "${clone}" init -q
git -C "${clone}" add -A
commit "${clone}" package
workspace "${C}" "$(jq -cn --arg spec "oh-my-claudeagent@git+file://${clone}" '{plugins: [$spec]}')"

UV_CACHE_DIR=${UV_CACHE_DIR:-$(uv cache dir)}
OPENCODE_PASSWORD=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
export UV_CACHE_DIR OPENCODE_PASSWORD OPENCODE_DB=:memory:
export XDG_CONFIG_HOME=${tmp}/config XDG_DATA_HOME=${tmp}/data XDG_CACHE_HOME=${tmp}/cache
port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
base=http://127.0.0.1:${port}

(cd "${tmp}" && exec setsid opencode serve --port "${port}" --hostname 127.0.0.1 --print-logs --log-level info >"${log}" 2>&1) &
server=$!

eight='[.data[].id | select(startswith("omca-"))] | length == 8'
explore='.data[] | select(.id == "omca-explore")'

poll "server started" 15 '.data' /api/agent "${A}"
pass "server started on 127.0.0.1:${port}"

poll "agents registered" 15 "${eight}" /api/agent "${A}"
agents_a=${out}
pass "8 omca-* agents registered"

check "omca-explore fields" \
  "${explore} | .mode == \"subagent\" and .steps == 30 and ([\"edit\", \"subagent\"] - [.permissions[] | select(.effect == \"deny\") | .action] == [])" \
  "${agents_a}" "${explore} | {mode, steps, permissions}"
pass "omca-explore is a subagent with steps 30 and edit/subagent denied"

check "model in A" "${explore} | .model.providerID == \"anthropic\" and .model.id == \"claude-opus-5-5\"" "${agents_a}" "${explore} | .model"
poll "agents registered in B" 15 "${eight}" /api/agent "${B}"
check "no model in B" "${explore} | .model == null" "${out}" "${explore} | .model"
pass "omca-explore model is anthropic/claude-opus-5-5 in A and unset in B"

skills=$(api GET /api/skill "${A}")
check "skills" '[.data[].id | select(startswith("omca-"))] | length == 5' "${skills}" '[.data[].id | select(startswith("omca-"))]'
check "skills" '.data[] | select(.id == "omca-handoff") | .autoinvoke == false' "${skills}" '.data[] | select(.id == "omca-handoff")'
commands=$(api GET /api/command "${A}")
check "commands" '[.data[].name | select(startswith("omca-"))] | length == 3' "${commands}" '[.data[].name]'
pass "5 omca-* skills with omca-handoff autoinvoke false, and 3 omca-* commands"

poll "omca MCP connected" 90 'any(.data[]; .name == "omca" and .status.status == "connected")' /api/mcp "${A}"
pass "omca MCP server connected"

created=$(api POST /api/session "${A}" --data "$(jq -cn --arg d "${A}" '{title: "smoke", location: {directory: $d}}')")
check "session location" ".data.location.directory == \"${A}\"" "${created}" '.data.location // .'
session=$(jq -r '.data.id' <<<"${created}")
head_before=$(git -C "${A}" rev-parse HEAD)
reset_code=$(api POST "/api/session/${session}/shell" "${A}" --data '{"command":"git reset --hard HEAD~1"}' -o /dev/null -w '%{http_code}')
[[ ${reset_code} != 2* ]] || fail "shell guard" "destructive command returned HTTP ${reset_code}"
head_after=$(git -C "${A}" rev-parse HEAD)
[[ ${head_after} == "${head_before}" ]] || fail "shell guard" "HEAD moved from ${head_before} to ${head_after}"
status_code=$(api POST "/api/session/${session}/shell" "${A}" --data '{"command":"git status"}' -o /dev/null -w '%{http_code}')
[[ ${status_code} == 2* ]] || fail "shell guard" "git status returned HTTP ${status_code}"
pass "shell guard blocked the reset (HTTP ${reset_code}, HEAD unchanged) and allowed git status (HTTP ${status_code})"

disabled=$(grep -c 'disabled plugin after transform failure' "${log}" || true)
ignored=$(grep -c 'omca: ignoring models\.' "${log}" || true)
[[ ${disabled} == 0 && ${ignored} == 1 ]] || fail "server log" "${disabled} disabled-plugin lines, ${ignored} ignoring-models lines"
pass "log has no disabled plugin line and one ignoring models line"

poll "git spec load" 60 "(${eight}) and any(.data[]; .id == \"omca-explore\" and (.system | length > 0))" /api/agent "${C}"
pass "git+file plugin spec loads 8 agents with a non-empty omca-explore system prompt"
