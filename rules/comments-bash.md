# pattern: *.sh

## Shell comment rules

Start each file with a header describing its contents.

Every function in a library gets a header comment regardless of length or complexity,
covering description, Globals used and modified, Arguments, Output to STDOUT or STDERR,
and Returns beyond the default exit status. Any non-obvious function elsewhere gets one
too.

Comment the tricky, non-obvious, interesting, or important parts. Do not comment
everything, and never restate the line below the comment.

`TODO` carries an owner or a bug reference: `# TODO(owner): short description`. Bare
`TODO: implement` is not a comment.

Name a numeric constant so the name explains the number. When the name cannot carry the
rationale (a measured threshold, a value that differs from a sibling), put a one-line
derivation comment above it, and write `UNDOCUMENTED` when the rationale is unrecoverable.

Comments are not a changelog, and never cite plan task numbers or plan filenames. Write
the invariant, not the history.
