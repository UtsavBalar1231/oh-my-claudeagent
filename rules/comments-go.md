# pattern: *.go

## Go comment rules

Every top-level exported name has a doc comment. It begins with the name of the declared
symbol and is a complete sentence: `// Quote returns a double-quoted Go string literal`,
not `// Returns a quoted string`.

Package comments begin with "Package " followed by the package name.

A predicate reads `// contains reports whether the string contains the byte c`, which
fixes the boolean's polarity. That is documentation, not narration.

`Deprecated:` paragraphs are consumed by tooling, so they are API surface. Never delete
or reword one as commentary.

Line comments are the norm; block comments appear mostly as package comments.

Do not restate the symbol name or a field name, and do not date-stamp changes: git owns
the history. `TODO` carries an owner or a tracking reference.
