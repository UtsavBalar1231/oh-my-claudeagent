# OMCA file formats, version 1

This page describes the formats OMCA reads and writes across sessions: plan documents, the task metadata it reads from Claude Code's task list, the evidence ledger and notepads. Each section ends with a worked example.

The ledger and the notepads are written only by the `omca` server's tools (`evidence_log`, `notepad_write`, `notepad_compact`). Every write replaces the whole file atomically under a lock file beside it, so a reader never sees a half-written file. No hook stops a direct edit, and a file edited into an unreadable shape stops the gates that read it. A plan document is the exception: you or the model write it, and OMCA never reads it. The tasks belong to Claude Code, which writes them; OMCA only reads them.

One JSON Schema (draft 2020-12) describes the ledger:

- [`evidence-ledger.v1.schema.json`](schemas/evidence-ledger.v1.schema.json)

The schema describes what the writer emits. The reader is more lenient, and the sections below say where.

## Versions

The ledger carries `"version": 1` as its first key. A file without `version` reads as version 1. Any other value is refused, and the refusal names the value it found.

## Plan documents

A plan is a Markdown file anywhere on disk. The planner writes plans to the plans directory (`plansDirectory`, else `plans/` in `CLAUDE_CONFIG_DIR`, or `~/.claude`) or to `.omca/plans` under the project for a project-local plan; `plansDirectory: ".omca/plans"` makes the second the default. `.omca/` is gitignored. Its headings, tables and prose are free-form: nothing about a plan is parsed, and no check reads or refuses a plan file. A run's progress, next task and completion come from the tasks, never from the document.

## Tasks

A run is a set of tasks in Claude Code's task list. Claude Code stores each task as `<config dir>/tasks/<list id>/<id>.json`, where the config dir is `CLAUDE_CONFIG_DIR` or `~/.claude`. The list id is `CLAUDE_CODE_TASK_LIST_ID`, which the mod sets at session start when nothing has, to `omca-<checkout name>-<8 hex characters of a hash of the checkout path>`, so one list serves every session in a checkout and its tasks outlive `/clear`. Claude Code deletes a list's files seconds after its last task completes.

OMCA reads these fields of a task file: `id`, `subject`, `description`, `activeForm`, `status` (`pending`, `in_progress` or `completed`), `owner`, `blocks`, `blockedBy` and `metadata`. A file that is not JSON, lacks `id`, `subject` or a known `status`, or carries `metadata._internal` is not a task. Three `metadata` keys are OMCA's:

| Key | Type | Meaning |
| --- | --- | --- |
| `run` | string | The run the task belongs to. A task without it is not part of a run and no OMCA gate reads it |
| `final` | `true` | The run's last task. It cannot close until a `final_verification` entry for it is logged |
| `blocked` | string | Why the task was given up on. It closes the task without completing it |

Any other `metadata` key is shown as plain text on the task's page in the Tasks pane.

### Open, closed and blocked

A task is open when its `status` is not `completed` and it has no `metadata.blocked`. A blocked task is closed for what runs next and is never counted as done. A task is held back by each id in its `blockedBy` that names a task still open.

| Question | pending or in progress | completed | blocked |
| --- | --- | --- | --- |
| The task-continuation gate counts it as remaining | yes | no | no |
| Candidate for the next task | yes, when nothing holds it back | no | no |
| Counted as done | no | yes | no |
| Releases a task that waits on it | no | yes | no |

### The final task

The last task of a run carries `metadata.final: true`. Marking it completed is refused until the ledger holds a `final_verification` entry with `exit_code` 0 and `task_id` equal to its id. A run is closed when it has a task and none is open. While the final task is open, the task-continuation gate holds the stop, and the gate stays silent for a closed run.

### Example

```json
{
  "id": "2",
  "subject": "Wire the order summary panel",
  "description": "Add the panel to the payment step and cover it with a test.",
  "activeForm": "Wiring the order summary panel",
  "status": "pending",
  "blocks": ["3"],
  "blockedBy": ["1"],
  "metadata": { "run": "checkout-redesign" }
}
```

The run's last task, which a passing `final_verification` for id `3` closes:

```json
{
  "id": "3",
  "subject": "Run the full suite and record the verdict",
  "status": "pending",
  "blocks": [],
  "blockedBy": ["2"],
  "metadata": { "run": "checkout-redesign", "final": true }
}
```

A task given up on states why:

```json
{
  "id": "4",
  "subject": "Migrate the legacy export",
  "status": "pending",
  "blocks": [],
  "blockedBy": [],
  "metadata": { "run": "checkout-redesign", "blocked": "the export service is not reachable from CI" }
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
| `task_id` | string | only when not empty | The id of the task a `final_verification` entry closes |
| `tree` | string | when git can produce it | The tree hash of the working directory as `git add -A` would record it, computed by the server with a scratch index, object directory and git-lfs storage. Claude Code's `.claude/worktrees` directory does not count. It is absent outside a git repository, or when git is missing, fails, or a git call takes over 3 seconds. A caller cannot supply it |

Lengths are counted in characters, not bytes. `evidence_log` rejects an unknown `type` and a non-integer `exit_code`.

### Reading

One reader parses every ledger. It refuses text that is not JSON, not an object, whose `entries` is present and not a list, or whose `version` is present and not 1. It returns the well-formed entries in file order and skips the rest. An entry is well-formed when `type` is a known type, `command` is a string, `exit_code` is a number and `timestamp` parses as a date. A missing `output_snippet` reads as empty. A skipped entry stays in the file, because the writer preserves every entry it reads.

`evidence_log` throws an error that names the file and writes nothing when the reader refuses the existing ledger. Move the file aside to keep logging. A missing file starts a new ledger. A document with no `entries` key is accepted by the writer, which adds the list, and counts as holding no entries in the TaskCompleted check below.

### Rotation

When the server starts, it checks the live ledger. If the file is over 1 MiB or holds more than 1,000 entries, all but the newest 500 entries move to `verification-evidence.<yyyymm>.json` in the same directory, named for the current UTC month. The archive is written first, so a crash duplicates entries and never loses one. An archive has the same format as the ledger, with `version` first, and a month's later rotations append to it. The gates and `evidence_read` read the live file only.

### What the gates accept

- **Task continuation gate.** A session that touched a task cannot stop while its run has an open task, the final task included.
- **Later code changes.** No gate reads `tree`. The Evidence tab shows a passing verdict as stale once a later entry carries a different `tree`, OpenCode's panel does the same, and at Stop a completion claim over a verdict whose `tree` differs from the working directory shows the user a message.
- **TaskCompleted.** Completing a run's final task is refused until the ledger holds the passing `final_verification` entry for it. A missing ledger counts as no evidence, and a ledger the reader refuses blocks with a message. For any task, when the session ran a verification command within the last hour, the ledger must have been modified at or after the time that command finished, give or take 2 seconds, and must hold at least one well-formed entry. A malformed entry beside a good one does not block.

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
      "command": "bun test",
      "exit_code": 0,
      "output_snippet": "418 pass, 0 fail",
      "timestamp": "2026-10-02T12:40:00Z",
      "verified_by": "orchestrator",
      "task_id": "3"
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

`notepad_read` returns each requested section as `# Learnings`, `# Issues` and so on, followed by the masked text, with `---` between sections. Text past 40,000 characters comes back as the newest content, under a `[TRUNCATED: older entries omitted: read one section or run notepad_compact]` header.

### Plan names

A plan name is 1 to 128 characters of letters, digits, `.`, `_` and `-`, starting with a letter or digit. It must also be a safe file name on Windows: not a device name such as `nul` or `COM1`, with or without an extension, and not ending in a dot. The notepad tools reject any other name.

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
