# Transcript-search tool verdict

Decision record: whether OMCA ships a transcript-search MCP tool. Gate:
build only if a named consumer needs something `rg` over the raw transcript
files cannot already give it, honestly stated deltas or none. Decided
2026-07-02.

## Named consumers

1. The verify-heuristics A/B benchmark's corpus extraction. If this tool is
   built, the benchmark can use it; if this tool is a no-go, the benchmark
   falls back to direct JSONL extraction per its own protocol. A real
   consumer, contingent on this gate.
2. Handoff/recap enrichment. An agent mid-session answering "what did we
   decide about X last session" needs role-scoped, bounded results it can
   read without blowing its own context window. `skills/handoff` today has
   no transcript-search step at all: this is a plausible future consumer,
   not a currently-wired one, but the need (bounded, role-filtered search
   over past turns) is real and unmet by any existing tool.

## The rg-delta claim, stated honestly

### Not a delta: slug resolution

The project-directory slug algorithm (every non-alphanumeric character in
the cwd path becomes `-`) already exists and is documented at
`scripts/lib/common.sh` lines 105-107:

```
# Session path layout: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
# <encoded-cwd>: working directory with every non-alphanumeric char → "-"
# (e.g. /home/user/my-project → -home-user-my-project; platform-applied, OMCA reads only)
```

`servers/tools/sessions.py` reuses this exact semantic in Python (one
implementation concept, ported across languages, not a new algorithm). It
was verified against a real directory on this machine: the git root
`/home/utsav/dev/softs/oh-my-claudeagent` slugs to
`-home-utsav-dev-softs-oh-my-claudeagent`, and that literal directory
exists under `~/.claude/projects/` with real `*.jsonl` transcripts inside
it. `rg` needs zero help finding that directory manually; a human or a
raw `rg --glob '*.jsonl' -i query ~/.claude/projects/<slug>/` invocation
could do the same walk. Slug resolution alone would not justify a new tool.

### Real delta 1: role/turn-structured extraction

Transcript JSONL lines are not text logs: they are full Claude Code
session-event records. A single turn line routinely runs into the tens of
KB (thinking blocks carry base64-ish signatures, tool_use blocks carry full
JSON inputs, tool_result blocks carry entire file contents or command
output). Confirmed by reading a live transcript at
`~/.claude/projects/-home-utsav-dev-softs-oh-my-claudeagent/*.jsonl`:
`message.content` is either a plain string (simple turns) or a list of
typed blocks (`text`, `thinking`, `tool_use`, `tool_result`), and the role
that actually matters to a search ("did the assistant say X", "did a tool
report Y") is not the same as the top-level `type` field alone; a
`tool_result` block lives inside a `user`-typed event but semantically
answers to "tool", not "user". A plain `rg` match returns the raw JSON line
verbatim: a caller gets a wall of escaped JSON with the match buried inside
a `thinking.signature` blob or a giant `tool_result.content` string, with
no role attribution and no way to filter by "assistant text only." Turning
that into "here is what the user asked, here is what the assistant said,
here is what a tool returned" requires parsing the block-typed content
structure, which `rg` cannot do.

### Real delta 2: bounded, de-noised output

Raw `rg` over a transcript directory returns full matching lines. Given
that a single line can be tens of KB (see above), a handful of matches can
blow a caller's context budget before it reads a single answer. The tool
caps each excerpt to roughly 200 characters around the hit and caps total
matches to `limit` (default 10, hard max 50), with a truncation notice when
more matches exist than are returned. `rg` has no equivalent of "give me
±100 chars around each hit, and only from the human-relevant text, not the
signature blob": `rg -A/-B` operates on line boundaries, and each
transcript line already is one match.

## Verdict: GO

Both deltas survive: role-structured extraction from oversized JSONL lines,
and bounded de-noised output. Neither is achievable with a bare `rg`
invocation. Building `servers/tools/sessions.py` with one read-only tool,
`session_search`, scoped to the resolved project's transcript directory
only (never scanning across other projects), returning capped structured
matches.
