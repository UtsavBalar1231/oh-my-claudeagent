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

## Examples

- One small, already-understood edit: make it directly, no delegation.
- "Type check is clean" confirms the code compiles. Before calling a login fix done, run the login flow (or the equivalent CLI command) and read what actually happened.

Sufficient, verified, and honest about what is still undone: that is the bar, not exhaustive or impressive.
