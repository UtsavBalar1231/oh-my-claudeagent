# OMCA file formats, version 1

This page describes the four formats OMCA reads and writes across sessions: plan files, the evidence ledger, notepads and the plan registry. Each section ends with a worked example.

The ledger, the registry and the notepads are written only by the `omca` server's tools (`evidence_log`, `boulder_write`, `notepad_write`, `notepad_compact`). Every write replaces the whole file atomically under a lock file beside it, so a reader never sees a half-written file. No hook stops a direct edit, and a file edited into an unreadable shape stops the gates that read it. A plan file is the exception: you or the model write it, and OMCA only reads it.

Two JSON Schemas (draft 2020-12) describe the JSON files:

- [`evidence-ledger.v1.schema.json`](schemas/evidence-ledger.v1.schema.json)
- [`plan-registry.v1.schema.json`](schemas/plan-registry.v1.schema.json)

Each schema describes what the writer emits. The readers are more lenient, and the sections below say where.

## Versions

Both JSON files carry `"version": 1` as their first key. A file without `version` reads as version 1. Any other value is refused, and the refusal names the value it found.

## Plan files

A plan is a Markdown file anywhere on disk. The registry records its path. Nothing about a plan is stored outside the file: progress, the next task and completion are all derived from its text each time they are needed.

### Metadata

A line of the form `**Status**: FINAL` or `**Status**: DRAFT` in any section before the first task sets the status the plan board shows. The match ignores case and the bold marks. The Stop gates do not read it.

### Tasks

A task is one line that matches this shape, with no indentation:

```text
- [ ] 12. Text of the task
- [x] 12. Text of the task
```

The box holds a space or a lowercase `x`. The number is one or more digits followed by a dot, and the text follows. A `- [ ]` line without a number, or a line with `[X]`, is not a task. When a plan file is written or edited, OMCA warns about each unchecked `- [ ]` line that has no number. Task numbers are not checked for order or uniqueness.

Before OMCA looks for tasks, it cleans the text: CRLF and lone CR become LF, and control characters, zero-width and bidirectional marks and the byte order mark are dropped. A task line inside a fenced code block is not a task. A line that starts, after any whitespace, with three backticks or three tildes opens or closes a fence, so a plan can show an example task safely.

### Sub-bullets

A task's details are sub-bullets indented two spaces under it, each of the form `- Name: text` with a capital letter starting the name. The plan board reads three names into structured fields: `File` or `Files` (the paths in the first code span of each comma-separated item), `Depends` or `Depends on` (task numbers) and `Done when` (code spans holding a command with an argument). It shows any other name, such as `Must NOT` or `Effort`, as plain text. No sub-bullet affects completion.

### Next task, progress and completion

The next-task label is the text of the first unchecked task, trimmed and cut to 80 code points. It is `null` when every task is checked. A longer text keeps its first 79 code points, trailing whitespace trimmed, followed by `…`. The count is in code points, so an emoji is never split.

A plan is complete when it has at least one task and every task is checked. A plan with no numbered tasks is never complete.

### The plan hash

`plan_sha256` is the SHA-256 of the plan file's raw bytes as stored, written as 64 lowercase hex characters. The bytes are not cleaned first, so a byte order mark, CRLF line endings or a trailing newline each change the hash, while the task reader ignores them. Editing the plan after logging a hash makes that hash stop matching.

### Example

````markdown
# Checkout redesign

**Status**: FINAL

## Tasks

- [x] 1. Add the order summary model
  - File: `src/orders/summary.ts`
  - Done when: `bun test src/orders` passes
- [ ] 2. Wire the order summary panel
  - File: `src/ui/summary-panel.ts`, `src/ui/checkout.ts`
  - Done when: `bun test src/ui` passes
  - Depends: 1
  - Must NOT: change the payment flow
  - Effort: medium
````

For this text, ending in one newline, `boulder_progress` reports:

```json
{
  "total": 2,
  "completed": 1,
  "remaining": 1,
  "is_complete": false,
  "plan_path": "/home/user/.claude/plans/checkout-redesign.md",
  "plan_sha256": "8273361d9a4d2edf9cf1b59d0e4683c346939c0fea1486acdd3860808a820caa",
  "next_task_label": "Wire the order summary panel"
}
```

## Evidence ledger

The ledger is `.omca/evidence/verification-evidence.json`. Only `evidence_log` writes it. It is append-only and never cleared automatically. Its schema is [`evidence-ledger.v1.schema.json`](schemas/evidence-ledger.v1.schema.json).

### Document

| Key | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | Written first. Optional when reading |
| `entries` | array | One object per logged run, oldest first |

The writer keeps any other top-level key it finds and writes `version` first.

### Entries

| Field | Type | Written | Meaning |
| --- | --- | --- | --- |
| `type` | string | always | One of `build`, `test`, `lint`, `manual`, `final_verification` |
| `command` | string | always | The command that ran, cut to 2,000 characters |
| `exit_code` | integer | always | The real exit code. For `final_verification`, 0 records COMPLETE |
| `output_snippet` | string | always | Relevant output, cut to 2,000 characters |
| `timestamp` | string | always | UTC at seconds precision, for example `2026-10-02T12:05:00Z` |
| `verified_by` | string | only when not empty | The agent or person that verified, cut to 200 characters |
| `plan_sha256` | string | only when not empty | The plan hash, 64 lowercase hex characters |

Lengths are counted in characters, not bytes. `evidence_log` rejects an unknown `type`, a non-integer `exit_code` and a `plan_sha256` that is not 64 lowercase hex characters or empty.

### Reading

One reader parses every ledger. It refuses text that is not JSON, not an object, whose `entries` is present and not a list, or whose `version` is present and not 1. It returns the well-formed entries in file order and skips the rest. An entry is well-formed when `type` is a known type, `command` is a string, `exit_code` is a number and `timestamp` parses as a date. A missing `output_snippet` reads as empty. A skipped entry stays in the file, because the writer preserves every entry it reads.

`evidence_log` throws an error that names the file and writes nothing when the reader refuses the existing ledger. Move the file aside to keep logging. A missing file starts a new ledger. A document with no `entries` key is accepted by the writer, which adds the list, and is treated as corrupt by the Stop gate below.

### Rotation

When the server starts, it checks the live ledger. If the file is over 1 MiB or holds more than 1,000 entries, all but the newest 500 entries move to `verification-evidence.<yyyymm>.json` in the same directory, named for the current UTC month. The archive is written first, so a crash duplicates entries and never loses one. An archive has the same format as the ledger, with `version` first, and a month's later rotations append to it. The gates and `evidence_read` read the live file only.

### What the gates accept

- **Stop gate.** A session bound to a plan cannot stop, once every task is checked, until the ledger holds a `final_verification` entry with `exit_code` 0 whose `plan_sha256` is empty or equals the plan file's current hash. An entry without a hash matches any plan. The gate treats a missing ledger as no evidence, and a ledger that the reader refuses, or that has no `entries` list, as corrupt. Both hold the stop with a message, within the gate's block budget.
- **TaskCompleted.** When the session ran a verification command within the last hour, the ledger must have been modified at or after the time that command finished, give or take 2 seconds, and must hold at least one well-formed entry. A malformed entry beside a good one does not block.

### Example

```json
{
  "version": 1,
  "entries": [
    {
      "type": "test",
      "command": "bun test src",
      "exit_code": 0,
      "output_snippet": "412 pass, 0 fail",
      "timestamp": "2026-10-02T12:05:00Z",
      "verified_by": "executor"
    },
    {
      "type": "final_verification",
      "command": "plan completeness review",
      "exit_code": 0,
      "output_snippet": "COMPLETE",
      "timestamp": "2026-10-02T12:40:00Z",
      "verified_by": "reviewer",
      "plan_sha256": "8273361d9a4d2edf9cf1b59d0e4683c346939c0fea1486acdd3860808a820caa"
    }
  ]
}
```

## Notepads

A notepad holds what a plan's work learned. Each plan has one directory, `.omca/notepads/<plan>/`, and each section is one Markdown file in it: `learnings.md`, `issues.md`, `decisions.md` and `problems.md`. A file exists once something is written to that section. `<plan>` is a plan name, which the next section defines.

### Entries

`notepad_write` appends one entry to a section file. An entry is a blank line, the heading `## <timestamp>`, a blank line, the text and a newline. The timestamp is UTC at seconds precision, such as `2026-10-02T10:05:00Z`. Nothing is overwritten.

A reader treats a line as an entry heading when it is `## ` followed by a date and optionally a time: `YYYY-MM-DD`, then `T` or a space and `HH:MM`, with optional seconds, fractional seconds and `Z`. A hand-written heading such as `## 2026-10-02 10:05` is accepted and read as local time. An entry runs from its heading to the next heading, so a line inside an entry's text that has the heading form starts a new entry. Text above the first heading belongs to no dated entry. The tool warns when a section file passes 50 KiB.

### Compaction

`notepad_compact` cuts one section down to 20 lines. It drops whole entries from the oldest end until at most 20 lines remain, counting each entry's heading and text. It always keeps the newest entry whole, even when that entry alone is longer than 20 lines. Text above the first heading counts as the oldest entry. When nothing needs dropping, the file is left unchanged.

After a cut, the section starts with the marker line `[Compacted: N earlier lines removed]`, where N is the total removed by this and every earlier compaction. Each kept entry follows, set off by a blank line. The removed text is not archived anywhere.

### Masking

The file keeps text as written. `notepad_read` masks secrets in what it returns, replacing each with `<masked>`, so masking is display only and never edits the file. The patterns are private key blocks, a `name=value` pair whose name ends in `password`, `passwd`, `token`, `secret` or `api_key` in any case (the name and equals sign stay), a `Bearer` token, an `sk-` key, GitHub and Slack tokens, an AWS access key id, a Google API key and a JSON web token. The pane's Notepad tab applies the same masks and also shows the home directory as `~`. Do not write a secret to a notepad, because the file holds it.

`notepad_read` returns each requested section as `# Learnings`, `# Issues` and so on, followed by the masked text, with `---` between sections.

### Plan names

A plan name is 1 to 128 characters of letters, digits, `.`, `_` and `-`, starting with a letter or digit. It must also be a safe file name on Windows: not a device name such as `nul` or `COM1`, with or without an extension, and not ending in a dot. The notepad tools and `boulder_write` reject any other name.

### Example

A `learnings.md` as written, with the first heading after a blank line:

```markdown

## 2026-10-02T10:05:00Z

The order summary needs the tax total before the discount.

## 2026-10-02T10:40:00Z

The deploy script failed when API_TOKEN=<value> was set in the shell.
```

`notepad_read` returns the second entry with the value masked: `... when API_TOKEN=<masked> was set in the shell.` If a compaction cut a section of 30 lines, made of entries of 12, 10 and 8 lines, it keeps the last two, which hold 18 lines, and the section begins:

```text
[Compacted: 12 earlier lines removed]
```

## Plan registry

The registry is `.omca/state/boulder.json`. Only `boulder_write` writes it, plus the server's own cleanup. Its schema is [`plan-registry.v1.schema.json`](schemas/plan-registry.v1.schema.json). One registry holds several plans, and each session binds to at most one.

### Document

| Key | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | Written first. Optional when reading |
| `plans` | object | Plan entries by plan name |
| `bindings` | object | Binding entries by session id |

The writer emits exactly these three keys and drops any other key when it rewrites the file. A reader ignores unknown keys, and reads a missing `plans` or `bindings` as empty.

### Plan entries

| Field | Type | Written | Meaning |
| --- | --- | --- | --- |
| `active_plan` | string | always | The path of the plan file |
| `started_at` | string | always | UTC at seconds precision when the plan was first registered. Registering again keeps it |
| `session_ids` | array of strings | always | Every session that registered the plan, in order |
| `worktree_path` | string | only when not empty | The worktree the plan runs in. Registering again keeps the earlier value unless a new one is given |

### Binding entries

| Field | Type | Written | Meaning |
| --- | --- | --- | --- |
| `plan_name` | string | always | A key of `plans` |
| `bound_at` | integer | always | Epoch seconds when the session was bound |

`boulder_write` writes a binding only when the session id is not empty. An empty id resolves to the session of the most recent hook call, or to the server's own session id before any hook has run.

### Resolution

Everything that acts for a session, such as the Stop gates, subagent start, the compaction note and the status line, resolves strictly: only the session's own binding counts, and only when the plan it names still exists. `boulder_progress` resolves leniently. Without a plan path or name it takes the session's binding, else the only registered plan, else the plan with the latest `started_at`, the first listed winning a tie. A lookup by plan name skips that order.

Completion is not stored. It is derived from the plan file's checkboxes, as the plan files section describes.

### Refusal

One reader parses the registry. It refuses text that is not JSON, not an object, whose `plans` or `bindings` is present and not an object, or whose `version` is present and not 1. A file that is an object with neither key reads as an empty registry.

`boulder_write` throws an error naming the file when the registry is refused, and never replaces it. Repair or delete the file, then register the plan again. Every other reader treats a refused registry as empty and writes nothing back, with one exception: the Stop gates treat text that is not valid JSON as corrupt. The plan continuation gate then holds the stop with a message naming the file, and the final verification gate stops enforcing.

### Cleanup

The server removes stale entries. At start, it drops bindings to plans that no longer exist and every unbound plan that is complete, whose plan file is missing, or that has no `active_plan`. An unbound incomplete plan with a plan file is kept. On each `boulder_write`, it drops bindings older than 7 days and unbound complete plans started more than 7 days ago. At exit, it removes the bindings this server process made.

### Example

```json
{
  "version": 1,
  "plans": {
    "checkout-redesign": {
      "active_plan": "/home/user/.claude/plans/checkout-redesign.md",
      "started_at": "2026-10-02T10:00:00Z",
      "session_ids": ["3f2b8c1e-7a4d-4c55-9b0e-1d2f6a8e9c10"],
      "worktree_path": "/home/user/work/checkout-redesign"
    }
  },
  "bindings": {
    "3f2b8c1e-7a4d-4c55-9b0e-1d2f6a8e9c10": {
      "plan_name": "checkout-redesign",
      "bound_at": 1790935200
    }
  }
}
```
