# Privacy policy

Effective 2026-10-12.

oh-my-claudeagent (OMCA) is a Claude Code plugin that runs on your machine.

## What OMCA collects

Nothing. OMCA has no account, no telemetry and no analytics.

## What OMCA sends

Nothing. OMCA's own code makes no network calls and ships no remote MCP server.

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

The cleanup runs when the `omca` server starts. Delete `.omca/` to remove everything OMCA stored
for a project.

Outside the project, `omca-setup` edits `~/.claude/settings.json` only after you confirm its diff,
keeps the previous file as `settings.json.omca-bak`, and copies a launcher to
`~/.claude/omca/statusline.ts`; `--uninstall` removes those entries and the launcher. The Doctor
tab's `refreshInterval` fix edits the same file the same way, with a backup. The status line
caches git state in a file in the system temp directory.

## Claude Code and other MCP servers

Claude Code sends your conversation to Anthropic as it does without OMCA, under Anthropic's
terms and privacy policy. An MCP server you add yourself, such as the optional documentation and
code search servers in the README, follows its own operator's policy. OMCA does not control
either.

## Questions

Open an issue at https://github.com/UtsavBalar1231/oh-my-claudeagent/issues or write to
utsavbalar1231@gmail.com.
