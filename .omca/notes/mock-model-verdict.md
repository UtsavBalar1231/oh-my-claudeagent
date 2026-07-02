# Mock-model spike: verdict

## Verdict: SUPPORTED

A headless `claude -p` turn on this machine, running under OAuth subscription auth, can be
pointed at a local mock endpoint. The inference request itself (a POST to `/v1/messages`
carrying a `messages` array) arrived at a local listener when `ANTHROPIC_BASE_URL` was set
on the `claude` subprocess. This is not a routing failure and not an auth failure. The
mock-model server work is unblocked and should proceed.

## Env contract

- **Variable**: `ANTHROPIC_BASE_URL` (documented Anthropic SDK env var; not listed in
  `claude --help`, so this was confirmed empirically rather than from CLI docs).
- **Scope**: set only on the `claude` subprocess via `env ANTHROPIC_BASE_URL=... claude ...`,
  never exported into the parent shell.
- **Path override**: requests went to `http://127.0.0.1:<port>/v1/messages?beta=true`, i.e.
  the CLI appends its normal request path to the overridden base URL rather than requiring
  the mock to replicate the full URL shape.
- **Credential mode**: subscription OAuth credentials flowed through automatically. Every
  request the listener saw carried an `Authorization` header (value redacted, presence
  logged) and the full set of `anthropic-beta` feature flags the CLI normally sends. The
  client does not skip attaching credentials just because the base URL points somewhere
  other than the real API.

## Methodology

Per the plan's isolation model: real `$HOME` preserved, everything else isolated at the
project layer. A scratch git project was created under `mktemp -d`-style scratch space
(not the dev checkout, not a real project). A minimal Python stdlib HTTP listener bound to
`127.0.0.1` on a random free port, logging method, path, and header presence (redacting
`Authorization`, `X-Api-Key`, and `Cookie` header values) to a local file.

Note on scope: this specific probe used a bare scratch project rather than the packaged
plugin via `--plugin-dir`. No OMCA hook or MCP behavior was under test here, only whether
credentialed inference traffic can be redirected at all, so the packaged-plugin step (used
in the v2.13 methodology for hook/tool probes) was unnecessary overhead for this question.

**Control run first** (no override): `claude -p "reply with the single word ok"` in the
scratch project. Exit 0, stdout `ok`. This proves the harness and auth are healthy before
touching anything.

**Probe run**: `env ANTHROPIC_BASE_URL="http://127.0.0.1:<port>" claude -p "reply with the
single word ok" --output-format text --debug`. Exit 1, stdout:

```
API Error: API returned an empty or malformed response (HTTP 200) — check for a proxy or gateway intercepting the request
```

The non-zero exit and malformed-response error are expected: the listener returned a
minimal stub body shaped like a Messages API response, not a byte-accurate one, so the SDK
client correctly complained about the response shape. That failure happens strictly after
the request was sent and received a 200, which is itself proof the request reached the
listener and got a response. It is not an auth-shaped failure (no 401/403, no
"authentication" text) and not a routing failure (the request did not go to the real
endpoint; the listener logged it directly).

## Listener log excerpt (headers redacted, body truncated)

```
{"ts": 1782998958.82, "method": "POST", "path": "/v1/messages?beta=true",
 "headers": {"Authorization": "<present, redacted>", "anthropic-version": "2023-06-01",
             "User-Agent": "claude-cli/2.1.198 (external, sdk-cli)", ...},
 "body_preview": "{\"model\":\"claude-opus-4-8\",\"messages\":[{\"role\":\"user\", ...}"}
```

Two POSTs were logged for the single probe turn (same session id, decreasing Content-Length
on the second), consistent with the CLI retrying once after the first malformed response
before giving up and surfacing the error to stdout.

## Drift watch

- `~/.claude/settings.json` whole-file sha256: identical before and after the probe run.
- `~/.claude.json` `oauthAccount` field, jq-extracted and hashed: identical before and
  after. No other top-level key in `~/.claude.json` maps to permissions/tool-allow state
  (checked `jq keys`); `oauthAccount` was the only sensitive field applicable here.
- No drift observed. No abort was needed.

## Expected side effects (not drift)

Two new transcript files appeared under
`~/.claude/projects/<scratch-project-path-slug>/` (one for the control run, one for the
probe run), matching the isolation model's statement that new files under
`~/.claude/projects/` are expected and listed here, not treated as drift.

## Teardown receipts

- Listener process killed after the probe run; confirmed no longer running via `pgrep`.
- Scratch project directory and listener script removed from the scratchpad after the
  run; nothing under the dev checkout or a real project was touched.
- No files in this repository were modified except this verdict note.

## Implication for the qa harness

SUPPORTED means the mock-model server is worth building: `session-smoke.sh` can run
a mock-backed smoke test by default (deterministic, no real API spend, no dependency on
subscription auth being healthy in CI-like contexts) instead of staying skip-by-default.
The env contract to reuse is exactly what this spike proved: set `ANTHROPIC_BASE_URL`
scoped to the `claude` subprocess only, and expect the mock server to receive real
Authorization headers and the full request body, so it does not need to fake an
unauthenticated flow, only shape a valid Messages API response.
