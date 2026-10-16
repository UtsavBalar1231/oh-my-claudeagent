# Privacy policy

Effective 2026-10-15.

oh-my-claudeagent (OMCA) runs inside Claude Code or an OpenCode V2 server. An
OpenCode server may be local or remote, as configured by its user.

## What OMCA collects

Nothing. OMCA has no account, no telemetry and no analytics.

## What OMCA sends

OMCA ships no remote MCP server and adds no external data-collection service.
Its OpenCode terminal panel requests session-scoped plan, evidence and notepad
snapshots through the host's authenticated client. With a remote OpenCode server,
these requests and their responses cross that server connection. The terminal
does not read remote filesystem paths on the client machine.

Claude Code's OMCA server, mod and status line make no network calls themselves.

## What OMCA reads and writes on your machine

OMCA's hooks read the prompt text, the inputs and outputs of Read, Write, Edit, Agent, Bash and
PowerShell calls, and the tail of the transcript when a session tries to stop. It runs local
`git` for its drift check. Its mod reads your settings file and a few environment variables, and
never writes them.

OMCA keeps its state in the project's `.omca/` directory:

- The plan registry, the evidence ledger and notepads stay until you remove them. The evidence
  ledger rotates into monthly archive files once it passes 1 MiB or 1,000 entries.
- Session status files and mod markers are deleted after a day untouched.
- Delegation records are deleted after 90 days.
- Temporary `*.tmp` files are deleted after a day.
- The `file_read` tool's log of the files it read stays until you remove it.

The cleanup runs when the Claude Code `omca` MCP server starts. OpenCode's native
adapter does not run that startup cleanup. Delete `.omca/` to remove OMCA's stored
project state. On a remote OpenCode deployment, that directory is on the server.

Outside the project, `omca-setup` edits `~/.claude/settings.json` only after you confirm its diff,
keeps the previous file as `settings.json.omca-bak`, and copies a launcher to
`~/.claude/omca/statusline.ts`; `--uninstall` removes those entries and the launcher. The Doctor
tab's `refreshInterval` fix edits the same file the same way, with a backup. The status line
caches git state in a file in the system temp directory.

## Hosts, model providers and other MCP servers

OMCA workflows may launch specialist sessions through the host using your configured
models. Conversations and tool results follow that host's and model provider's
data policies. An MCP server you add yourself follows its operator's policy.
OMCA does not control those services.

## Questions

Open an issue at https://github.com/UtsavBalar1231/oh-my-claudeagent/issues or write to
utsavbalar1231@gmail.com.
