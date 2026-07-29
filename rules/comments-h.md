# pattern: *.h

## Header comment rules

Comments tell WHAT the code does, not HOW. Never explain how the code works: write code
whose working is obvious instead.

A header carries the contract, so the doc comment belongs at the head of the declaration
it documents. Do not add boilerplate kernel-doc that reiterates the signature: parameter
names, types, and arity are already visible.

Document what the signature cannot carry: inclusive versus exclusive bounds, ownership of
the result, valid flag combinations, and who provides the locking.

kernel-doc `Context:` (which locks are held, whether the call may sleep, IRQ safety) and
`Return:` (every return value, including every error code) are load-bearing. Write them
where they apply and never strip them.

Keep the include guard and any SPDX or license header untouched.

`TODO` carries an owner or a tracking reference.
