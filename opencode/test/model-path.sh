#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/omca-model-path.XXXXXX")
ws="${tmp}/ws"
stub_pid=""
server_pid=""

cleanup() {
  set +e
  for pid in ${server_pid} ${stub_pid}; do
    kill "${pid}" 2>/dev/null
    wait "${pid}" 2>/dev/null
  done
  rm -rf "${tmp}"
}
trap cleanup EXIT

pass() { echo "PASS $1"; }
fail() {
  echo "FAIL $1: $2"
  [[ -f "${tmp}/server.log" ]] && tail -n 20 "${tmp}/server.log" >&2
  exit 1
}

free_port() { python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }

export XDG_CONFIG_HOME="${tmp}/config" XDG_DATA_HOME="${tmp}/data" XDG_CACHE_HOME="${tmp}/cache" OPENCODE_DB=":memory:"
OPENCODE_PASSWORD=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
export OPENCODE_PASSWORD
export STUB_LOG="${tmp}/requests.jsonl"
mkdir -p "${XDG_CONFIG_HOME}" "${XDG_DATA_HOME}" "${ws}/.opencode"
: >"${STUB_LOG}"

bun "${repo}/opencode/test/stub-provider.ts" >"${tmp}/stub.out" 2>&1 &
stub_pid=$!
for _ in $(seq 50); do
  grep -q '^listening' "${tmp}/stub.out" && break
  sleep 0.1
done
stub_port=$(awk '/^listening/ {print $2}' "${tmp}/stub.out")
[[ -n "${stub_port}" ]] || fail stub "stub did not start: $(cat "${tmp}/stub.out")"

git_c=(git -c user.name=omca -c user.email=omca@localhost -C "${ws}")
"${git_c[@]}" init -q
echo one >"${ws}/file.txt"
"${git_c[@]}" add file.txt
"${git_c[@]}" commit -qm one
echo two >"${ws}/file.txt"
"${git_c[@]}" commit -qam two

cat >"${ws}/.opencode/opencode.jsonc" <<EOF
{
  "model": "stub/scripted",
  "providers": {
    "stub": {
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:${stub_port}/v1", "apiKey": "stub" },
      "models": {
        "scripted": {
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"] },
          "limit": { "context": 200000, "output": 32000 }
        }
      }
    }
  },
  "plugins": [{ "package": "${repo}/opencode" }]
}
EOF

port=$(free_port)
server="http://127.0.0.1:${port}"
(cd "${ws}" && exec opencode serve --port "${port}" --hostname 127.0.0.1 --print-logs --log-level info) >"${tmp}/server.log" 2>&1 &
server_pid=$!

loc=$(jq -rn --arg d "${ws}" '$d | @uri')
api() { curl -s -u "opencode:${OPENCODE_PASSWORD}" "${server}/api/$1?location%5Bdirectory%5D=${loc}"; }

for _ in $(seq 30); do
  models=$(cd "${ws}" && opencode models --server "${server}" 2>&1 || true)
  grep -q 'stub/scripted' <<<"${models}" && break
  sleep 1
done
grep -q 'stub/scripted' <<<"${models}" || fail models "opencode models does not list stub/scripted: ${models}"

for _ in $(seq 90); do
  mcp=$(api mcp)
  jq -e '.data[]? | select(.name == "omca" and .status.status == "connected")' <<<"${mcp}" >/dev/null 2>&1 && break
  sleep 1
done
jq -e '.data[]? | select(.name == "omca" and .status.status == "connected")' <<<"${mcp}" >/dev/null ||
  fail mcp "omca MCP server never connected: ${mcp}"

run() {
  (cd "${ws}" && timeout 180 opencode run --server "${server}" --model stub/scripted --auto --format json "OMCA-SCENARIO:$1") \
    >"${tmp}/run-$1.json" 2>&1 || true
}

systems='[.messages[]? | select(.role == "system") | .content | if type == "string" then . else ([.[]?.text] | join("\n")) end] | join("\n")'
explorer='# Explorer - Codebase Search Specialist'
evidence='Evidence before claims'

tool_results_since() {
  tail -n +"$(($1 + 1))" "${STUB_LOG}" | jq -r 'select(.messages[-1].role == "tool") | .messages[-1].content | if type == "string" then . else ([.[]?.text] | join("\n")) end'
}

head_before=$("${git_c[@]}" rev-parse HEAD)
start=$(wc -l <"${STUB_LOG}")
run shell-reset
[[ "$("${git_c[@]}" rev-parse HEAD)" == "${head_before}" ]] || fail shell-reset "HEAD moved"
result=$(tool_results_since "${start}")
[[ "${result}" == *"omca guard:"* ]] || fail shell-reset "no omca guard denial reached the model"
pass shell-reset

start=$(wc -l <"${STUB_LOG}")
run subagent
sessions=$(api session)
jq -e '.data[]? | select(.parentID != null)' <<<"${sessions}" >/dev/null || fail subagent "no child session: ${sessions}"
jq -e --arg h "${explorer}" "select((${systems}) | contains(\$h))" "${STUB_LOG}" >/dev/null ||
  fail subagent "no request carried the omca-explore system"
[[ "$("${git_c[@]}" rev-parse HEAD)" == "${head_before}" ]] || fail subagent "HEAD moved"
child_result=$(tail -n +"$((start + 1))" "${STUB_LOG}" |
  jq -r --arg h "${explorer}" "select(.messages[-1].role == \"tool\" and ((${systems}) | contains(\$h))) | .messages[-1].content | if type == \"string\" then . else ([.[]?.text] | join(\"\n\")) end")
[[ "${child_result}" == *"omca guard:"* ]] || fail subagent "no omca guard denial reached the omca-explore child"
pass subagent

jq -e --arg h "${explorer}" --arg e "${evidence}" "select(.tools and ((${systems}) | contains(\$h) | not) and ((${systems}) | contains(\$e)))" \
  "${STUB_LOG}" >/dev/null || fail context "no build request contains '${evidence}'"
if jq -e --arg h "${explorer}" --arg e "${evidence}" "select(((${systems}) | contains(\$h)) and ((${systems}) | contains(\$e)))" \
  "${STUB_LOG}" >/dev/null; then
  fail context "the omca-explore request contains '${evidence}'"
fi
pass context

build_tools=$(jq -c --arg h "${explorer}" "select((.tools | length) > 0 and ((${systems}) | contains(\$h) | not)) | [.tools[].function.name]" "${STUB_LOG}")
[[ -n "${build_tools}" ]] || fail tools "no build request carried tools"
jq -se 'all(index("omca_evidence_log"))' <<<"${build_tools}" >/dev/null || fail tools "a build request lacks omca_evidence_log"
jq -e 'select([.tools[]?.function.name] | index("omca_session_search"))' "${STUB_LOG}" >/dev/null &&
  fail tools "a request exposes omca_session_search"
pass tools

start=$(wc -l <"${STUB_LOG}")
run skill-load
result=$(tool_results_since "${start}")
[[ -n "${result}" ]] || fail skill-load "no follow-up request carried the skill result"
[[ "${result}" == *"/omca-handoff"* ]] || fail skill-load "skill result lacks /omca-handoff"
[[ "${result}" != *"oh-my-claudeagent:"* ]] || fail skill-load "skill result contains untranslated oh-my-claudeagent: text"
pass skill-load
