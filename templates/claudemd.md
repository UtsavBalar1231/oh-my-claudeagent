# oh-my-claudeagent orchestration guidance

oh-my-claudeagent (OMCA) is installed. This guidance arrives with a session's first prompt and again after compaction; the output style carries the rules for every turn.

## Entrypoints

- `/oh-my-claudeagent:plan <task>`: an interview, a draft, gap analysis by metis and review by momus, ending in a plan file.
- `/oh-my-claudeagent:start-work [plan path]`: runs an approved plan at depth 0, one executor per task, evidence logged per task. Only the user starts it.
- `/oh-my-claudeagent:hephaestus` for a broken build, `/oh-my-claudeagent:omca-setup` for setup and checks, `/oh-my-claudeagent:handoff` for a summary a new session can continue from.
- `/omca` opens OMCA's pane (Agents, Plan, Evidence, Notepad, Feedback, Stats, Doctor), `/omca doctor` checks the environment, and `/omca-rate up|down [note]` rates the last turn.

Keyword triggers ("create plan", "fix build", "setup omca") work only when `enableKeywordTriggers` is on.

## Agents

| Agent             | Model  | Effort | Use when                                                   |
| ----------------- | ------ | ------ | ---------------------------------------------------------- |
| prometheus        | opus   | high   | Planning interviews and structured plans                   |
| metis             | opus   | high   | Gaps in a request or a draft plan                          |
| momus             | opus   | high   | Reviewing a plan before execution                          |
| executor          | sonnet | high   | One scoped change, verified before it reports              |
| explore           | sonnet | high   | Finding code in this repo                                  |
| librarian         | sonnet | high   | External docs, library usage, open-source examples         |
| oracle            | fable  | xhigh  | Architecture, stuck debugging, review of significant work  |
| hephaestus        | opus   | medium | Build, type, toolchain and dependency failures             |
| multimodal-looker | opus   | medium | Screenshots, PDFs, diagrams                                |
| sisyphus          | opus   | high   | Orchestrating a multi-step job as a subagent               |

Pick the agent whose tier fits the work. Pass `model="opus"` only when one task needs more judgment than its agent's tier. To change one delegation's effort, make `[omca-route effort=<low|medium|high|xhigh|max>]` the first line of its prompt; the hint carries no model.

An explore or librarian prompt states CONTEXT (task, files), GOAL (the decision it unblocks), DOWNSTREAM (how the result will be used) and REQUEST (what to find, in what form, what to skip). Any other delegation states one TASK, the EXPECTED OUTCOME, the REQUIRED TOOLS, the SCOPE (requirements and exclusions, each with its reason) and the CONTEXT (paths, patterns, constraints).

Consult the `advisor`, when you have it, before committing to a large plan, when the same error comes back, and before calling a long task done. It reads the whole conversation, so it needs no briefing. `/advisor fable` or `/advisor opus` turns it on, and `/omca doctor` reports what keeps it off.

## When a fix keeps failing

After three failed attempts at one fix, stop editing. Revert only your own edits by editing them back: a `/rewind` checkpoint restores neither shell changes nor a background subagent's edits, and `git restore` goes to OMCA's guard. Note what you tried, then ask the advisor, or oracle with the full context, before the next attempt. If oracle cannot unblock it, ask the user.

## Reading outside the project root

Use the omca `file_read` tool. `permissions.blockReadsOutsideWorkingDirectories` fences Read, Grep, Glob and LSP to the working directories, not MCP tools.
