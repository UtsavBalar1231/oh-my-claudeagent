---
name: remove-ai-slops
description: "Use to strip AI slop from changed files (double guards, dead fallbacks, narrating comments, premature abstraction) while keeping load-bearing validation and error handling. Triggers: 'remove ai slop', 'de-slop'."
---

# Remove AI slop

Clean only the requested files or reviewed diff. Read each candidate before cutting redundant guards, dead fallbacks, narrating comments, or unused abstractions. Do not introduce replacement abstractions, change public signatures or algorithms, or weaken test assertions. Use `references/categories.md` for examples and borderline cases.

Preserve load-bearing validation, error/data-loss handling, security controls, and comments that explain contracts or non-obvious constraints. Keep license/SPDX and file/module headers, API docs, `// SAFETY:` rationale, locking/concurrency and `Context:` contracts, invariants and constant derivations, error/panic semantics, units and boundary conditions, deprecation notices, bug-linked workarounds, and project-mandated comments.

Before deleting a trust-boundary guard or catch, test an adversarial input and prove the remaining path handles the same failure. Trace callers and mutation paths before declaring a check redundant. No proof means no deletion. Do not turn an environment assumption into a guarantee about external input.

Apply small cuts, safest first. Delegate independent batches only if the current role permits it; give each worker its exact files and the protection rules. Leaf workers make their own cuts.

Run the relevant project build, lint, and tests after cuts. If the commands are unknown, ask rather than guess. Log real exits with `evidence_log`. Report per file the cuts, what stays and why, and any uncertainty. For a bound plan, record consequential judgment calls with `notepad_write`.
