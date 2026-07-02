# Boulder telemetry verdict

Task 11 of `omca-deferred-hardening-v2-14`. Gate: a candidate telemetry field
qualifies only if some real consumer would act on data that cannot already be
derived from an existing source. The existing sources, confirmed by reading
the live code, are:

- Plan checkboxes in the plan file itself: completion and the next unchecked
  task. `plan_is_complete()` and `next_task_label()` in
  `servers/tools/_boulder_core.py` (lines 40-54 and 25-37) derive both purely
  from the file's `- [ ] N.` / `- [x] N.` markers. No stored completion flag
  exists anywhere in `boulder.json`.
- Evidence file timestamps: recency of build/test/lint runs, read from
  `.omca/evidence/verification-evidence.json` entry timestamps (schema in
  `.claude/rules/state-schemas.md`, verification-evidence.json section).
- Plan file mtime: filesystem-level, available to any reader via `stat`, no
  boulder field needed. `commands/start-work.md` line 123-124 already shows a
  "Modified: {date}" column in the plan-selection listing, which reads this.
- `bindings[session_id].bound_at`: when the current session bound to its
  plan. Set only by `boulder_write`, per `.claude/rules/state-schemas.md`
  boulder.json section.
- `plans[plan_name].started_at` and `.session_ids`: when a plan was first
  registered, and which sessions have ever touched it. Also from
  `boulder_write`, same schema section.

## Candidates evaluated

### (a) Resume-picker ordering

Would need: some ordering signal to rank candidate plans when multiple are
registered and no binding resolves for the current session.

Derivable today: yes. `resolve_bound_plan()` in
`servers/tools/_boulder_core.py` (lines 143-167) already orders the
no-binding, multi-plan case by `max(plans, key=lambda name:
plans[name].get("started_at", ""))`, i.e. most-recently-started plan wins.
`commands/start-work.md` (lines 50-51) describes the exact same ladder:
explicit binding, then sole plan, then most-recently-started plan. The
plan-selection listing (lines 116-124) additionally shows file "Modified"
date (filesystem mtime, not a boulder field) alongside checkbox progress
(derived from the plan file). Every input this candidate would need
(`started_at`, file mtime, checkbox progress) already exists and is already
wired into the ordering and the display. There is nothing left to measure.

Verdict: no-go. Already fully served by `started_at` (stored) plus
filesystem mtime (free) plus derived checkbox progress.

### (b) Stale-plan display in the statusline

Would need: an "idle since" or "last touched" signal so the statusline could
flag a plan as stale.

Derivable today: yes, from the same two fields as (a). `started_at` marks
plan creation, and the plan file's own mtime marks the last edit (which, for
an actively-worked plan, is the last checkbox flip). Neither requires a new
boulder field. The current `_todo_counter()` in `statusline/core.py`
(lines 383-439) does not render a staleness indicator at all today, but if
one were added, it would read `started_at` from the plan's registry entry
(already present in the `plans[plan_name]` dict it already opens) and the
plan file's `stat().st_mtime` (already resident on disk, one syscall away).
No write path, no schema change, no new field.

Verdict: no-go. `started_at` plus filesystem mtime already suffice; this is
a display-code change, not a data-model gap.

### (c) Abandoned-state marking

Would need: a stored `status` or `abandoned` flag on `plans[plan_name]`.

This fails automatically, independent of whether some consumer could act on
it. `.claude/rules/state-schemas.md` states plainly: "Completion is derived,
not stored. There is no `completed_at` field." The master protect list in
`.omca/notes/openagent-deep-dive-2026-07.md` (the "Master protect list (do
not regress)" section) names this explicitly: "Derived-only plan completion;
flock+mkstemp boulder writes (theirs: bare writeFileSync, no GC)." A stored
`abandoned` flag is completion's sibling: another out-of-band status field
that can drift from the plan file's actual checkbox state the moment someone
edits the plan directly, resumes it later, or a stale write races a fresh
edit. That is exactly the dual-source-of-truth failure mode the derived-only
design exists to prevent, and the strategy memory's "heaviest state for the
least gate value" indictment (line 29 of the same notes file, "Boulder
telemetry (optional, measure first per liability lens)") is a direct warning
against adding it without proof of need.

"Abandoned" is itself also fully derivable without a stored flag: a plan
with no binding, an old `started_at`, and an old file mtime is what
"abandoned" already looks like given (a) and (b) above; the resolver and GC
code express this today, without a status field, via
`gc_prune_unbound()` in `servers/tools/_boulder_core.py` (lines 57-84),
which already prunes unbound, checkbox-complete, or file-missing plans on
every `boulder_write`.

Verdict: automatic fail, not a bar-fails-honestly case. Storing this field
would be a regression against the protect list, not merely a data-modeling
choice.

### (d) Candidate identified independently: cross-session "who is on this plan right now"

Reading `statusline/core.py` and `commands/start-work.md` end to end, the
one place a display genuinely wants a signal beyond the four listed above is
"is another session concurrently working this plan right now," which
`commands/start-work.md` line 58-59 calls out directly: "The registry's
OTHER concurrently-active plans (`plans[plan_name]` entries not bound to
this session), each labeled `[active]`."

Would need: whether some other session currently holds a binding to a given
plan.

Derivable today: yes. `bindings` is keyed by `session_id` and each entry
carries `plan_name`. "Is anyone else on plan X" is a membership check over
the existing `bindings` map (any entry whose `plan_name == X` and whose
`session_id` is not the caller's own), already exposed by the same
`boulder.json` read every consumer already performs. No new field, no new
write, just a different query over data that is already there.

Verdict: no-go. Fully derivable from the existing `bindings` map.

## Verdict

No-go on all four candidates. Every genuine display or ordering need traces
back to `started_at` (stored), the `bindings` map (stored), the plan file's
own checkboxes (derived), or the plan file's filesystem mtime (free, not
boulder state at all). The one candidate that would need a new stored field,
abandoned-state marking, fails automatically because it recreates the
dual-source-of-truth problem the derived-only completion design was built to
avoid, and the protect list forbids that regression by name.

This closes the audit item permanently under the current consumer set. It
would reopen only if a concrete new consumer appeared that needs a
non-derivable signal, for example: a consumer that must know exact wall
clock duration a plan was actively worked (not just started_at to now, but
cumulative active time across multiple sessions with gaps), which none of
`started_at`, `bindings`, file mtime, or checkbox state can reconstruct.
Nothing in the current statusline, start-work selection flow, or GC logic
needs that, so until such a consumer is named and scoped, boulder.json stays
exactly as it is.

No implementation follows from this task. No files under
`servers/tools/_boulder_core.py`, `servers/tools/boulder.py`,
`.claude/rules/state-schemas.md`, or `statusline/core.py` were touched.
