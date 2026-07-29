# Code comment conventions

Authoritative per-language comment policy for this repo and for code this plugin's agents
write. Every rule below is attributed to a first-party style guide, a language RFC, or an
upstream source file. Where a rule has no first-party source, it says so in place.

`sources verified 2026-07-29`

The link checker in `scripts/validate-plugin.sh` (`check_docs_accuracy`) scans only README.md,
OMCA.md, and CONTRIBUTING.md, so nothing revalidates the URLs in this file automatically. Treat
the stamp above as the vintage and re-verify before relying on a quote in a review. Every
per-language source is indexed in the Sources table at the end.

## Quick rules

| # | Rule | Applies to | Source |
|---|---|---|---|
| 1 | A comment that contradicts the code is worse than no comment. Update comments with the code. | all | PEP 8 |
| 2 | Do not restate the line below the comment. Cover the comment, read the code, and ask what was lost. | all | Google Python 3.8, PEP 8, Kernel |
| 3 | Never explain HOW the code works. Explain `WHAT, not HOW`. | kernel C/H | Kernel coding-style 8 |
| 4 | Do not comment everything. Comment the tricky, non-obvious, interesting, or important parts. | all | Google Shell |
| 5 | Every public / exported API gets a doc comment. | Go, Rust, Python, Bash libraries | Google Go, RFC 505, PEP 257, Google Shell |
| 6 | A doc comment must not reiterate the signature. Types, parameter names, and arity are already visible. | all | PEP 257, Kernel doc-guide, Google Python 3.8 |
| 7 | Failure modes are documentation, not narration: `Return:`, `# Errors`, `# Panics`, `Returns:`. | kernel C, Rust, Python, Go | Kernel doc-guide, Rust API Guidelines C-FAILURE |
| 8 | Every `unsafe` block carries a `// SAFETY:` comment, and safe code must not. | Rust | clippy `undocumented_unsafe_blocks`, `unnecessary_safety_comment` |
| 9 | `TODO` carries an owner or a tracking reference. Bare `TODO: implement` is not a comment. | all | Google Shell, Google C++, Google Python |
| 10 | Comments are not a changelog. Git owns the history. | all | project-local, see category 10 in `skills/remove-ai-slops/references/categories.md` |
| 11 | Delete commented-out code rather than shipping it. | all | project-local policy, NOT ecosystem consensus. See "Sourcing corrections" below. |
| 12 | Line comments are the norm; avoid block comments. | Rust, Go | RFC 505, Effective Go |
| 13 | Numeric constants in this repo's shell scripts carry a derivation comment. | this repo's `scripts/*.sh` | `.claude/rules/hook-scripts.md` |

## Bash

Bash is the one language here whose first-party guide asks for more comments rather than fewer,
and it is the language this repo writes most of. Do not carry a minimize-comments instinct from
the Go or Rust sections into a shell script. Quoting the Google Shell Style Guide:

- **File header.** "Start each file with a description of its contents."
- **Function headers.** "Any function in a library must have a comment regardless of length or
  complexity." The comment covers description, globals used and modified, arguments, output to
  STDOUT or STDERR, and returned values other than the default exit status.
- **Implementation comments.** "Comment tricky, non-obvious, interesting or important parts of
  your code." Balanced against "Don't comment everything": headers are structural and always
  required, inline commentary is selective.
- **TODO format.** `# TODO(owner): short description`, owner being a name, username, or bug ref.

Good, the header shape the guide itself publishes:

```bash
#######################################
# Cleanup files from the backup directory.
# Globals:
#   BACKUP_DIR
# Arguments:
#   None
#######################################
function cleanup() {
```

Bad:

```bash
# Set count to 0
count=0
# Loop over the files
for f in "$@"; do
```

Two comments, zero information. Both restate their line. Compare rule 2.

`.claude/rules/hook-scripts.md` governs `scripts/*.sh` in this checkout and is stricter than the
Google guide. Read it rather than a restatement. Two intersections matter for cleanup work: it
**mandates** a derivation comment above every numeric constant (protected class 12 below), and
it **forbids** plan-reference comments, meaning plan task numbers, plan basenames, and "Task N
of X". Write the invariant, not the history.

## Python

PEP 8: "Comments that contradict the code are worse than no comments. Always make a priority of
keeping the comments up-to-date when the code changes!"

PEP 8, on inline comments: "Inline comments are unnecessary and in fact distracting if they
state the obvious."

PEP 257: "The one-line docstring should NOT be a 'signature' reiterating the
function/method parameters (which can be obtained by introspection)."

PEP 257, on mood: the docstring "prescribes the function or method's effect as a command ('Do
this', 'Return that'), not as a description; e.g. don't write 'Returns the pathname ...'."

Google Python 3.8: "Never describe the code. Assume the person reading the code knows Python
better than you do."

Google's guide treats annotated parameters as already documented for type. A docstring
repeating `x: int` as "x: an integer" adds nothing and goes stale independently of it.

Good, from CPython `Lib/textwrap.py`
(https://github.com/python/cpython/blob/main/Lib/textwrap.py). Abridged:

```python
def dedent(text):
    """Remove any common leading whitespace from all lines in text.

    Note that tabs and spaces are both treated as whitespace, but they
    are not equal: the lines "  hello" and "\\thello" are
    considered to have no common leading whitespace.

    Entirely blank lines are normalized to a newline character.
    """
```

It states the effect, then the two things a caller cannot infer and the signature does not
carry: tabs and spaces do not compare equal, and blank lines are normalized.

Bad:

```python
def get_user(user_id: int) -> User | None:
    """Get user.

    Args:
        user_id: An int representing the user id.
    """
    # Query the database
    row = db.fetch_one("SELECT * FROM users WHERE id = ?", user_id)
```

The docstring restates the signature (PEP 257 says not to), the `Args` type is already in the
annotation, and the inline comment states the obvious (PEP 8). Missing: whether `None` means
"absent" or "soft-deleted", and whether this hits the database on every call.

## Kernel C and H

The kernel's rule is not the popular "why, not what" formula. It says the opposite of what most
readers expect:

> "Generally, you want your comments to tell WHAT your code does, not HOW."

Same section:

> "NEVER try to explain HOW your code works in a comment: it's much better to write the code so
> that the working is obvious, and it's a waste of time to explain badly written code."

The second quote explains the first: the kernel treats HOW as something the code itself must
carry, and reserves the comment for the contract, the WHAT. This document uses the kernel's
literal wording, `WHAT, not HOW`, when citing the kernel. See correction 1 below.

The kernel-doc guide adds rule 6 in its own words:

> "Do not add boilerplate kernel-doc which simply reiterates what's obvious from the signature
> of the function."

Two kernel-doc sections inside a `/** ... */` block are load-bearing and must never be stripped:
`Context:` (which locks are held, whether the call may sleep, whether it is IRQ-safe) and
`Return:` (every return value, including every error code).

Good, from `idr_alloc_u32()` in https://github.com/torvalds/linux/blob/master/lib/idr.c.
Abridged:

```c
/**
 * idr_alloc_u32() - Allocate an ID.
 * @max: The maximum ID to allocate (inclusive).
 *
 * Note that @max is inclusive whereas the @end parameter to idr_alloc()
 * is exclusive.  The new ID is assigned to @nextid before the pointer
 * is inserted into the IDR, so if @nextid points into the object pointed
 * to by @ptr, a concurrent lookup will not find an uninitialised ID.
 *
 * The caller should provide their own locking to ensure that two
 * concurrent modifications to the IDR are not possible.
 *
 * Return: 0 if an ID was allocated, -ENOMEM if memory allocation failed,
 * or -ENOSPC if no free IDs could be found.
 */
```

Three things a naive cleanup pass would destroy, none of them in the signature: `@max` is
inclusive while the sibling `idr_alloc()` takes an exclusive `end`, the store-then-insert
ordering makes a concurrent lookup safe, and the caller provides the locking.

Bad:

```c
/**
 * foo_alloc() - Allocate a foo.
 * @gfp: The gfp flags.
 *
 * Return: A pointer to a foo.
 */
struct foo *foo_alloc(gfp_t gfp)
{
	/* Allocate memory for the foo */
	struct foo *f = kzalloc(sizeof(*f), gfp);
```

The kernel-doc block reiterates the signature, which the doc-guide names explicitly. The inline
comment explains HOW, which coding-style section 8 forbids. Missing: whether the caller may
sleep given `gfp`, and who frees the result.

## Rust

RFC 505 fixes the three comment forms: `//!` documents the enclosing item (crate and module docs
at the top of a file), `///` documents the following item and every public API, and `//` is an
ordinary implementation comment not extracted into docs. RFC 505 also says to avoid block
comments, which is rule 12.

RFC 1574: "The summary line should be written in third person singular present indicative form.
Basically, this means write 'Returns' instead of 'Return'." It also fixes the heading as
`# Examples`, always plural, even with one example.

The API Guidelines mandate three sections: **C-FAILURE** (`# Panics` for a function that can
panic, `# Errors` for one returning `Result`), `# Safety` for the invariants a caller of an
`unsafe fn` must uphold, and **C-EXAMPLE** for `# Examples` with runnable code.

Safety comments are machine-checked in both directions. The std dev guide requires a
`// SAFETY:` comment on every `unsafe` block justifying why the operation is sound, and clippy
`undocumented_unsafe_blocks`
(https://rust-lang.github.io/rust-clippy/master/index.html#undocumented_unsafe_blocks) fires
when one is missing. The inverse lint matters just as much for cleanup work:
`unnecessary_safety_comment`
(https://rust-lang.github.io/rust-clippy/master/index.html#unnecessary_safety_comment) fires on
a `// SAFETY:` comment attached to safe code. A misplaced one is a defect, not noise.

Good, `NonNull::new_unchecked` in
https://github.com/rust-lang/rust/blob/master/library/core/src/ptr/non_null.rs:

```rust
/// Creates a new `NonNull`.
///
/// # Safety
///
/// `ptr` must be non-null.
```

Four lines, and the `# Safety` section is the entire reason the function is callable at all.
Nothing here is inferable from `pub const unsafe fn new_unchecked(ptr: *mut T) -> Self`.

Bad:

```rust
/// Get the value.
///
/// This function gets the value from the inner cell and returns it.
pub fn get(&self) -> u32 {
    // Lock the mutex
    let guard = self.inner.lock().unwrap();
```

Third-person indicative violated ("Get" instead of "Gets", per RFC 1574), the second doc
paragraph restates the summary, the inline comment narrates. Absent: `unwrap()` on a poisoned
mutex panics, which C-FAILURE says goes under `# Panics`.

## Go

Doc comments "should begin with the name of the declared symbol" and be complete sentences,
which is why they read `// Quote returns ...` rather than `// Returns ...`. Package comments
begin with the word "Package" followed by the package name.

Deprecation is tool-consumed, not decorative: "Paragraphs starting with `Deprecated:` are
treated as deprecation notices." Editors and `go vet`-adjacent tooling read that prefix, so a
`Deprecated:` paragraph is machine-readable API surface, never "changelog-style commentary."

Effective Go: "Line comments are the norm; block comments appear mostly as package comments."
Google Go style: "All top-level exported names must have doc comments."

Good, from https://github.com/golang/go/blob/master/src/strconv/quote.go:

```go
// Quote returns a double-quoted Go string literal representing s. The
// returned string uses Go escape sequences (\t, \n, \xFF, \u0100) for
// control characters and non-printable characters as defined by
// IsPrint.
func Quote(s string) string {
```

Unexported, and equally worth keeping:

```go
// contains reports whether the string contains the byte c.
func contains(s string, c byte) bool {
```

The unexported one is the shape of a correct minimal doc comment: symbol name first, one
sentence, conventional "reports whether" phrasing for a predicate. It is not narration, because
it fixes the boolean's polarity, which a caller otherwise reads the body to learn.

Bad:

```go
// User struct
type User struct {
	ID int // the id
}

// GetUser gets a user
// Changed 2026-04-02: added caching
// TODO: implement pagination
func GetUser(id int) (*User, error) {
```

Five defects: the type comment does not start with a sentence naming the symbol, the field
comment restates the field name, the doc comment is a tautology, the dated line is a changelog
entry that git already owns, and the `TODO` has no owner and no tracking reference.

## Sourcing corrections

Three claims in this area are commonly asserted without a source. Each is stated here in the
form the evidence supports.

### 1. The kernel says WHAT, not HOW

The single most misquoted rule here. The kernel's literal wording is `WHAT, not HOW`. The
popular "why, not what" formula is a different claim from a different author, and attributing it
to https://www.kernel.org/doc/html/latest/process/coding-style.html#commenting is wrong.

### 2. The `TODO(owner)` format is not sourced to Google's Go style guide

Google publishes its Go style guide across four files under
https://google.github.io/styleguide/go/decisions#commentary and its siblings. Grepping all four
for `TODO(` returns zero hits: there is `no TODO section` in Google's Go guide, so the format
cannot be sourced to it. Source it instead to the Google Shell
(https://google.github.io/styleguide/shellguide.html), C++
(https://google.github.io/styleguide/cppguide.html, TODO comments section), or Python
(https://google.github.io/styleguide/pyguide.html) guides. For Go, `TODO(owner)` is de-facto
standard-library practice rather than a documented rule: see `// TODO(bradfitz):` in
https://github.com/golang/go/blob/master/src/net/http/server.go.

### 3. "Delete commented-out code" is project-local, not ecosystem consensus

No first-party style guide in Bash, Python, kernel C, Rust, or Go mandates deleting
commented-out code. Effective Go (https://go.dev/doc/effective_go#commentary) arguably points
the other way, noting block comments are useful for temporarily disabling large swaths of code.

Rule 11 is therefore **project-local policy for this repo**. The usual citation is Robert C.
Martin, *Clean Code*, chapter 4 ("Comments"), which lists commented-out code as a bad comment
because readers will not delete it and it rots in place. That attribution is secondary and
unverified against a physical copy, so treat the rule as ours, not as an appeal to authority.

## The counterweight

This document must not be read as "delete all comments". John Ousterhout, *A Philosophy of
Software Design*, chapter 12.1:

> "Some people believe that if code is written well, it is so obvious that no comments are
> needed. This is a delicious myth, like a rumor that ice cream is good for your health: we'd
> really like to believe it! Unfortunately, it's simply not true."

Chapter 12 carries the argument for why comments exist at all: without them you cannot hide
complexity, and an abstraction whose contract lives only in its implementation is not an
abstraction, because every caller has to read the body.

Ousterhout's chapter 13 red flag is the rule this document enforces: **Comment Repeats Code**.
That is a test for one specific defect, not a license to strip. Over-aggressive cleanup fails
worse than a few redundant comments: a stripped `Context:` field or `// SAFETY:` justification
removes information that exists nowhere else in the program.

## Protected classes

Cleanup passes, lint autofixes, and slop-removal skills must NEVER remove any of the following.
This list is the input contract for the cleanup skill.


1. **License and SPDX headers.** Legal artifacts.
2. **File and module headers.** Mandated for shell by
   https://google.github.io/styleguide/shellguide.html.
3. **Crate, package, and module docs.** Rust `//!`, Go `// Package x ...`, Python module
   docstrings.
4. **Public and exported API docs.** Google Go requires them for all top-level exported names;
   RFC 505 and PEP 257 require them for their ecosystems.
5. **`// SAFETY:` justifications.** Removing one trips clippy
   `undocumented_unsafe_blocks` and deletes the only record of why an `unsafe` block is sound.
6. **Locking, concurrency, and `Context:` contracts.** kernel-doc `Context:`, and any prose
   stating which locks are held or whether a call may sleep.
7. **Non-obvious invariants, units, and boundary conditions.** The inclusive-versus-exclusive
   note in `idr_alloc_u32()` is the canonical example.
8. **Error, panic, and failure semantics.** kernel-doc `Return:`, Rust `# Errors` and
   `# Panics`, Go and Python return-error documentation.
9. **Deprecation notices.** Go's `Deprecated:` paragraphs are tool-consumed
   (https://go.dev/doc/comment); removing one silently un-deprecates an API in tooling.
10. **Workaround rationale with a bug link.** A comment naming an upstream defect plus its
    tracking URL is the only place that constraint is recorded.
11. **Algorithm complexity notes.** Reasoned from principle, not sourced: no first-party guide
    in these five ecosystems names complexity annotations. Kept because a stated bound
    (`O(n log n)`) is a contract a caller depends on and cannot cheaply rederive.
12. **Project-local mandated comments.** The magic-number derivation comments required by
    `.claude/rules/hook-scripts.md` for every numeric constant in this repo's shell scripts are
    CI-pinned in `tests/bats/hooks/misc_hooks.bats`, so stripping them as "narrating comments"
    turns a cleanup into a test failure. Any repo with its own mandated-comment rule gets the
    same protection; check for one before running a cleanup pass.

## Sources

| Language | Source | URL |
|---|---|---|
| Bash | Google Shell Style Guide | https://google.github.io/styleguide/shellguide.html |
| Python | PEP 8, Comments | https://peps.python.org/pep-0008/#comments |
| Python | PEP 257, Docstring Conventions | https://peps.python.org/pep-0257/ |
| Python | Google Python Style Guide 3.8 | https://google.github.io/styleguide/pyguide.html |
| Python | `textwrap.dedent` example | https://github.com/python/cpython/blob/main/Lib/textwrap.py |
| Kernel C | Linux coding style, section 8 | https://www.kernel.org/doc/html/latest/process/coding-style.html#commenting |
| Kernel C | kernel-doc format | https://www.kernel.org/doc/html/latest/doc-guide/kernel-doc.html |
| Kernel C | `idr_alloc_u32()` example | https://github.com/torvalds/linux/blob/master/lib/idr.c |
| Rust | RFC 505, API comment conventions | https://rust-lang.github.io/rfcs/0505-api-comment-conventions.html |
| Rust | RFC 1574, more API doc conventions | https://rust-lang.github.io/rfcs/1574-more-api-documentation-conventions.html |
| Rust | API Guidelines, documentation | https://rust-lang.github.io/api-guidelines/documentation.html |
| Rust | std dev guide, safety comments | https://std-dev-guide.rust-lang.org/policy/safety-comments.html |
| Rust | clippy `undocumented_unsafe_blocks` | https://rust-lang.github.io/rust-clippy/master/index.html#undocumented_unsafe_blocks |
| Rust | clippy `unnecessary_safety_comment` | https://rust-lang.github.io/rust-clippy/master/index.html#unnecessary_safety_comment |
| Rust | `NonNull::new_unchecked` example | https://github.com/rust-lang/rust/blob/master/library/core/src/ptr/non_null.rs |
| Go | Go doc comments | https://go.dev/doc/comment |
| Go | Effective Go, commentary | https://go.dev/doc/effective_go#commentary |
| Go | Google Go style, decisions | https://google.github.io/styleguide/go/decisions#commentary |
| Go | `strconv.Quote` example | https://github.com/golang/go/blob/master/src/strconv/quote.go |
| Go | de-facto `TODO(owner)` practice | https://github.com/golang/go/blob/master/src/net/http/server.go |
| Cross-language | Google C++ Style Guide, TODO comments | https://google.github.io/styleguide/cppguide.html |

Books, no URL: John Ousterhout, *A Philosophy of Software Design*, chapters 12 and 13. Robert C.
Martin, *Clean Code*, chapter 4 (attribution is secondary, unverified against a physical copy).

Repo-local policy, not a URL: `.claude/rules/hook-scripts.md`,
`skills/remove-ai-slops/references/categories.md` (categories 4 and 10).
