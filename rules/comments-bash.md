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

Every numeric constant assignment carries a single-line derivation comment within two
lines above it. When the rationale is unrecoverable, write `UNDOCUMENTED` rather than
guessing.

Comments are not a changelog, and never cite plan task numbers or plan filenames. Write
the invariant, not the history.
