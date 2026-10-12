# pattern: *.rs

## Rust comment rules

`///` documents the following item and every public API. `//!` documents the enclosing
crate or module. `//` is an ordinary implementation comment. Line comments are the norm;
avoid block comments.

The summary line is third person singular present indicative: "Returns the length", not
"Return the length". Do not restate it in the paragraph below.

Write these sections where they apply: `# Errors` for a function returning `Result`,
`# Panics` for one that can panic, `# Safety` for the invariants a caller of an
`unsafe fn` must uphold, and `# Examples`, always plural even with a single example.

Every `unsafe` block carries a `// SAFETY:` comment justifying why the operation is
sound. A `// SAFETY:` comment attached to safe code is itself a lint violation; delete it
rather than leaving it in place.

`TODO` carries an owner or a tracking reference.
