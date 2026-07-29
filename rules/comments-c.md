# pattern: *.c

## C comment rules

Comments tell WHAT the code does, not HOW. Never explain how the code works: write code
whose working is obvious instead.

Keep comments at the head of the function. In-function comments exist only to flag
something genuinely clever or ugly, never to narrate steps.

Do not add boilerplate kernel-doc that reiterates the signature. Parameter names, types,
and arity are already visible.

Document what the signature cannot carry: inclusive versus exclusive bounds, ordering
guarantees, who frees the result, and who provides the locking.

kernel-doc `Context:` (which locks are held, whether the call may sleep, IRQ safety) and
`Return:` (every return value, including every error code) are load-bearing. Write them
where they apply and never strip them.

`TODO` carries an owner or a tracking reference.
