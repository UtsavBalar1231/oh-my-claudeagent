# cc-statusline

Near-instant Claude Code status rendering via daemon architecture.

cc-statusline renders a rich, multi-line status display for Claude Code sessions. It shows
model, git state, context usage, cost, duration, and OAuth usage limits — all with ANSI color
and optional Nerd Font glyphs.

---

## What it shows

In a git project with an active session, the output is up to three lines:

```
  claude-sonnet-4-5 · * main ~2 +1 · > my-project
▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 34%  200k · $0.12 · ~ 1m 42s · +87/-23
▰▰▰▱▱▱▱▱▱▱ 28%  (5h resets 4pm) · ▰▰▱▱▱▱▱▱▱▱ 18%  (7d resets thu 9am)
```

**Line 1 — context info**: model name, git branch + status counts, project directory name
(OSC 8 hyperlink to remote when available), extra directories, active agent, worktree, output
style, vim mode.

**Line 2 — metrics**: context window usage bar with percentage and window size label, session
cost, total duration, lines added/removed.

**Line 3 — usage limits**: 5-hour and 7-day utilization bars with reset times. Omitted when
usage data is unavailable or `CLAUDE_STATUSLINE_NO_USAGE` is set.

**Single-line fallback**: when there is no git repo, no agent, no worktree, and no vim mode,
lines 1 and 2 are merged into a single compact line.

Color thresholds for progress bars: green below 60%, yellow 60-84%, red 85%+. A red `!` marker
appears on Line 2 when context exceeds 200k tokens on a 200k window.

---

## Architecture

Three operating modes handle different latency requirements:

```
Claude Code hook
      |
      v
cc-statusline (client)
      |
      +--[daemon running]--> Unix socket --> StatuslineDaemon
      |                                           |
      |                                     render + cache
      |                                           |
      +--[daemon down]-----> auto-start daemon, retry
      |
      +--[CLAUDE_STATUSLINE_MODE=direct]--> render inline
      |
      +--[all else fails]--> render inline (final fallback)
```

**Daemon mode** (default): The client connects to a long-running daemon process over a Unix
domain socket. The daemon keeps the Python interpreter and usage cache warm, eliminating the
~19ms startup + import cost per render.

**Auto-start**: On the first failed connection attempt, the client uses a file lock
(`/tmp/cc-statusline-{uid}.lock`) to start the daemon exactly once, then retries. Subsequent
clients connect to the running daemon immediately.

**Direct mode**: Set `CLAUDE_STATUSLINE_MODE=direct` to skip the daemon entirely. Each render
imports and runs everything inline. Useful for debugging or environments where background
processes are undesirable.

**Fallback**: if all daemon interaction and auto-start fails, the client falls back to direct
rendering. On any unrecoverable error, `[claude]` is printed.

---

## Installation

cc-statusline is deployed by the `omca-setup` skill (Phase 5.6). It copies the `statusline/`
directory to `~/.claude/statusline/` and runs `uv sync` to install the package in an isolated
virtual environment.

For manual installation:

```bash
cp -r statusline ~/.claude/statusline
cd ~/.claude/statusline
uv sync
```

To register the statusline with Claude Code, configure the `statusline` key in
`~/.claude/settings.json` to call `cc-statusline` with stdin from the session JSON payload.

---

## CLI reference

| Command | Entry point | Purpose |
|---|---|---|
| `cc-statusline` | `statusline.client:main` | Main renderer — reads JSON from stdin, returns rendered output |
| `cc-statusline-daemon` | `statusline.daemon:main` | Daemon lifecycle management |
| `cc-statusline-direct` | `statusline.direct:main` | Inline renderer — reads JSON from stdin, no daemon interaction |

### cc-statusline-daemon subcommands

```
cc-statusline-daemon [start]      Start daemon in background (default)
cc-statusline-daemon --foreground  Run in foreground (for debugging)
cc-statusline-daemon stop          Send SIGTERM to the running daemon
cc-statusline-daemon status        Print "running" or "stopped"
```

---

## Configuration

All configuration is via environment variables. No config files.

| Variable | Values | Default | Effect |
|---|---|---|---|
| `CLAUDE_STATUSLINE_MODE` | `daemon`, `direct` | `daemon` | `daemon`: try daemon, auto-start, fall back to direct. `direct`: always render inline, never contact daemon. |
| `CLAUDE_STATUSLINE_NERD_FONT` | `1`, `0` | `1` | Override Nerd Font glyph usage. Takes precedence over `NERD_FONT`. |
| `NERD_FONT` | `1`, `0` | `1` | Fallback Nerd Font preference when `CLAUDE_STATUSLINE_NERD_FONT` is not set. |
| `CLAUDE_STATUSLINE_NO_USAGE` | any non-empty value | unset | Disable OAuth usage API calls entirely. Line 3 is never rendered. |

When neither `CLAUDE_STATUSLINE_NERD_FONT` nor `NERD_FONT` is set, Nerd Font glyphs are
enabled by default. Set either variable to `0` to use ASCII fallbacks (`*` for branch,
`>` for model/folder, `~` for clock, etc.).

---

## Wire protocol

The client and daemon communicate over a Unix domain socket using a line-based text protocol.

**Socket paths**:
- Linux: abstract namespace socket `\0cc-statusline-{uid}` (auto-cleaned on process exit)
- macOS / other: filesystem socket `/tmp/cc-statusline-{uid}.sock`

**PID file**: `/tmp/cc-statusline-{uid}.pid` (used by `stop` and `status` subcommands)

**Request format**:
```
<version>\t<json_payload>\n
```

**Response format**:
```
<version>\tOK\n<rendered_output>\n
```
or on error:
```
<version>\tERR\n[claude]\n
```

The current protocol version is `1`. The daemon closes the connection after sending its
response. The client has a 1-second socket timeout; connection failures fall through to
direct rendering.

---

## Daemon lifecycle

- **Idle shutdown**: The daemon shuts itself down after 1800 seconds (30 minutes) of
  inactivity. Each successful request resets the idle timer.
- **Usage refresh**: Usage data is fetched from the Anthropic OAuth API once on startup and
  then refreshed in a background thread every 300 seconds (5 minutes). The cached value is
  served to all render requests between refreshes.
- **Stale socket cleanup** (macOS only): On startup, the daemon checks for a stale filesystem
  socket from a previous crashed run and removes it before binding.
- **Graceful shutdown**: SIGTERM and SIGINT both trigger a clean shutdown, cancelling timers
  and removing the PID file and filesystem socket.

---

## Usage API

Line 3 (usage limits) is populated by `statusline.usage.get_usage()`, which calls the
Anthropic OAuth usage endpoint.

**Endpoint**: `https://api.anthropic.com/api/oauth/usage`

**Credential sources** (tried in order):
1. `~/.claude/.credentials.json` — reads `claudeAiOauth.accessToken`, checks `expiresAt`
2. macOS Keychain — `security find-generic-password -s "Claude Code-credentials" -w`

**Caching**: Responses are cached to `/tmp/cc-statusline-usage-{uid}` with a 300-second TTL.
The daemon pre-fetches and refreshes this cache in the background; the client reads from cache
and skips the fetch when a fresh cached entry exists.

**Circuit breaker**: After 3 consecutive API failures, the client backs off exponentially
starting at 300 seconds and doubling on each subsequent failure, capped at 3600 seconds.
During backoff, the cached value (if available) is returned; otherwise `_NONE_RESULT` is
returned (all fields None, Line 3 is omitted).

**Beta header**: Requests include `anthropic-beta: oauth-2025-04-20`. If the API returns
HTTP 400 with this header, it is stripped and the request is retried once without it.

**Response fields parsed**:

| Field | Source in API response |
|---|---|
| `five_hour_pct` | `five_hour.utilization` |
| `five_hour_resets_at` | `five_hour.resets_at` |
| `seven_day_pct` | `seven_day.utilization` |
| `seven_day_resets_at` | `seven_day.resets_at` |
| `seven_day_sonnet_pct` | `seven_day_sonnet.utilization` |
| `seven_day_sonnet_resets_at` | `seven_day_sonnet.resets_at` |
| `extra_usage_enabled` | `extra_usage.is_enabled` |

When `extra_usage_enabled` is true, a `+` suffix appears after the 7-day usage bar.

---

## Git info

Git metadata is fetched by `statusline.git.get_git_info(project_dir)` and cached to
`/tmp/claude-statusline-git-{hash}` with a 5-second TTL. The hash is derived from the
project directory path.

The fetch uses an optimized two-subprocess approach:
1. Read `.git/HEAD` directly (file read, ~0.05ms) for branch name
2. `git status --porcelain=v2 --branch -u` for staged, modified, and untracked counts

Worktrees are supported: when `.git` is a file (worktree pointer) rather than a directory,
the gitdir path is resolved from the file contents and HEAD is read from there.

The remote URL (`origin`) is fetched via a third subprocess call to handle
`url.insteadOf` rewrites and `includeIf` config. SSH remote URLs (`git@host:user/repo.git`)
are converted to HTTPS for the OSC 8 hyperlink in Line 1.

---

## Module reference

| Module | Key exports | Purpose |
|---|---|---|
| `statusline.core` | `render(data, git_info, usage)` | Main rendering function; also exports `FALLBACK`, `GIT_CACHE_TTL`, `detect_nerd_font()`, `build_glyphs()` |
| `statusline.client` | `main()` | CLI entry for `cc-statusline`; handles mode dispatch, daemon auto-start, direct fallback |
| `statusline.daemon` | `main()`, `StatuslineDaemon`, `StatuslineHandler` | Unix socket server; CLI for `cc-statusline-daemon` |
| `statusline.direct` | `main()` | CLI entry for `cc-statusline-direct`; inline render, no daemon |
| `statusline.git` | `get_git_info(project_dir)` | Git metadata with 5s disk cache |
| `statusline.usage` | `get_usage()` | OAuth usage API with 300s cache and circuit breaker |
| `statusline.__init__` | `__version__` | Package version (`1.0.0`) |

---

## Development

The package has zero runtime dependencies (Python stdlib only, requires Python 3.10+).

Run the renderer directly against a JSON payload:

```bash
echo '{"model": {"display_name": "claude-sonnet-4-5"}, "context_window": {"used_percentage": 42}}' \
  | python3 -m statusline.direct
```

Test the daemon manually:

```bash
# Start in foreground
cc-statusline-daemon --foreground

# In another terminal, send a request
printf '1\t{"model": {"display_name": "claude-sonnet-4-5"}, "context_window": {}}\n' \
  | nc -U /tmp/cc-statusline-$(id -u).sock   # macOS
# Linux uses abstract socket -- use Python:
python3 -c "
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect('\x00cc-statusline-$(id -u)')
s.sendall(b'1\t{\"model\":{\"display_name\":\"claude-sonnet-4-5\"},\"context_window\":{}}\n')
print(s.recv(4096).decode())
s.close()
"
```

Check daemon status and stop it:

```bash
cc-statusline-daemon status   # prints "running" or "stopped"
cc-statusline-daemon stop     # sends SIGTERM
```

To disable Nerd Font glyphs in your shell for testing ASCII fallbacks:

```bash
CLAUDE_STATUSLINE_NERD_FONT=0 echo '...' | cc-statusline
```
