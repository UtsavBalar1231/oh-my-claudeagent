# pattern: *.py

## Python comment rules

Drop any inline comment that states the obvious. A comment that contradicts the code is
worse than no comment: update comments with the code.

A docstring must not reiterate the signature. Annotations already carry types, so
`user_id: An int representing the user id` adds nothing and goes stale on its own.

A one-line docstring is a phrase ending in a period, written as a command: "Return the
pathname", never "Returns the pathname".

Use `Args:`, `Returns:`, and `Raises:` for the parts a caller cannot infer. Document what
the signature cannot carry: whether `None` means absent or soft-deleted, whether the call
hits the database, units, and boundary conditions.

Never describe the code. Assume the reader knows Python better than you do.

`TODO` carries an owner or a tracking reference.
