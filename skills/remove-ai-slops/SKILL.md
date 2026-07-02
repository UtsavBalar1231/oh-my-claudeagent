---
name: remove-ai-slops
description: "Strip AI-generated code slop from changed files: double-guards, dead fallbacks, redundant re-validation, narrating comments, speculative flexibility, premature abstraction, and more. Each category pairs with a KEEP rule and a trust-boundary proof requirement, so cleanup never strips load-bearing validation or error handling. Triggers: 'remove ai slop', 'clean up generated code', 'de-slop', 'remove defensive clutter', 'strip ai slop', 'clean up ai-generated code'."
---

# Remove AI Slop

Code-level cleanup for changes an LLM wrote (yours or someone else's), scoped to a bounded set of files. This skill is judgment work: it decides what to cut and, just as often, what to leave. A mechanical comment checker already strips some obvious slop on write; this skill covers the categories that need reading the code to call correctly.

Ten categories live in `references/categories.md`: what each looks like, the KEEP rule that names what must survive, and, for anything touching a trust boundary, the proof a deletion needs before it happens.

## Workflow

1. **Scope.** Default to the diff of the change under review, or an explicit file list if the caller hands you one. Do not wander into files outside that scope, even when you spot slop in passing. Note it and move on.
2. **Categorize.** Read every file in scope against the ten categories in `references/categories.md`. Build a per-file list of candidate cuts, each tagged with its category and a one-line reason.
3. **Batch and apply.**
   - If you are orchestrating (this skill was invoked from a session that can delegate), split the file list into small batches and hand each batch to an executor with the category list and KEEP rules attached, so each executor evaluates independently rather than inheriting your first pass's blind spots.
   - If you are a leaf worker (no delegation available), edit the files directly, one category at a time, safest first: comments, then dead code, then defensive clutter, then everything else.
   - For any cut inside `references/categories.md`'s trust-boundary set, apply the proof requirement before removing anything. No adversarial case, no deletion.
4. **Verify.** Run the project's own build, lint, and test commands on the touched files. A cleanup that breaks the build is not a cleanup. If the project's build/test story is unclear, ask rather than guess.
5. **Record.** Log each verification with `evidence_log`. If you're mid-plan and find a category boundary you had to call by judgment (kept something that looked like slop, or cut something that looked defensible), write it to the plan's notepad so the decision survives past this turn.

## Reporting

State, per file: what got cut (category, one line why), what got kept and why the KEEP rule applied, and what you weren't sure about. "Removed some dead code" is not a report. Silence on a skipped file is not a report either: say what you didn't touch and why.

## Boundaries

This skill does not touch test files' assertions, does not change public function signatures, does not introduce new abstractions to replace old ones, and does not rewrite algorithms under the banner of cleanup. An equivalence claim that needs a proof is a refactor, not slop removal, and belongs in its own change.
