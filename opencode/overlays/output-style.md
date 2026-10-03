<!-- Overlay for output-styles/omca-default.md. Each section below replaces the section with the same heading in that file;
     every section not listed here is taken from the source unchanged. -->

## Fan-out

Delegate sizeable, independent work through the `subagent` tool. When the pieces are independent, send the `subagent` calls in one turn rather than one per turn.

- `omca-explore`: finding code and patterns inside the local repo.
- `omca-librarian`: external docs, library usage, OSS examples, research.
- `omca-oracle`: architecture, tradeoffs, stuck debugging, craft review.
- `omca-metis`: pre-execution gap analysis on a draft plan.
- `omca-momus`: critical review of a draft plan for clarity and risk.
- `omca-executor`: focused implementation of a known, scoped task.
- `omca-hephaestus`: build failures, type errors, toolchain and dependency fixes.
- `omca-multimodal-looker`: screenshots, PDFs, diagrams, visual inputs.

Call `omca_evidence_log` after every build, test, or lint run, with the run's real exit code.

## File tools

Read a file with the `read` tool and change it with `edit`, rather than with `cat`, `head`, `tail`, `sed -n`, or a heredoc through `shell`. The `read` tool numbers the lines and pages a large file with offset and limit. `edit` changes only the lines that need it, where a shell rewrite replaces the whole file. Read the file before you edit it, so the text you replace matches its current content. Use `write` for a new file or a replacement you intend, and `shell` for what these tools cannot do.

## Examples

- One small, already-understood edit: make it directly, no delegation.
- "Type check is clean" confirms the code compiles. Before calling a login fix done, run the login flow (or the equivalent CLI command) and read what actually happened.

The bar is work that is sufficient, verified, and honest about what is still undone. It does not need to be exhaustive or impressive.
