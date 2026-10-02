# Ship the checkout redesign

**Scope**: about 30 files | **Parallel Execution**: NO | **Status**: FINAL

## Why
- The current checkout takes five screens and loses the cart when a card is declined.
- Support hears about it daily, and conversion drops 9% at the payment step.

## Work Objectives
### Must have
- A three-step flow that keeps the cart through a declined card.
### Must not have
- No new payment provider and no change to the stored order schema.

## Design decisions
| Decision | Choice | Reason |
|---|---|---|
| State | one draft order per cart | survives a reload |
| Validation | inline, per field | no round trip to the server |

## TODOs

### Foundations

- [x] 1. Add the cart totals module
  - File: `src/totals.ts`
  - Do: Add the cart totals module, keep the checkout interface as it is, and leave the stored order schema alone.
  - Done when: `bun test src/totals.spec.ts` exits 0 and the old code path is gone.
  - Depends: none
- [x] 2. Move tax rates into config
  - File: `src/tax.ts`
  - Do: Move tax rates into config, keep the checkout interface as it is, and leave the stored order schema alone.
  - Done when: `bun test src/tax.spec.ts` exits 0 and the old code path is gone.
  - Depends: 1
- [x] 3. Cover totals with unit tests
  - File: `src/totals.spec.ts`
  - Do: Cover totals with unit tests, keep the checkout interface as it is, and leave the stored order schema alone.
  - Done when: `bun test src/totals.spec.ts` exits 0 and the old code path is gone.
  - Depends: 2
- [x] 4. Add the address form schema
  - File: `src/address.ts`
  - Do: Add the address form schema, keep the checkout interface as it is, and leave the stored order schema alone.
  - Done when: `bun test src/address.spec.ts` exits 0 and the old code path is gone.
  - Depends: 3

### Checkout flow

- [x] 5. Build the address step
  - File: `src/steps/address.tsx`
  - Do: Build the address step, keep the checkout interface as it is, and leave the stored order schema alone.
  - Done when: `bun test src/steps/address.spec.ts` exits 0 and the old code path is gone.
  - Depends: 4
- [x] 6. Build the payment step
  - File: `src/steps/payment.tsx`
  - Do: Build the payment step, keep the checkout interface as it is, and leave the stored order schema alone.
  - Done when: `bun test src/steps/payment.spec.ts` exits 0 and the old code path is gone.
  - Depends: 5
- [ ] 7. Wire the order summary panel
  - File: `src/steps/summary.tsx`
  - Do: Wire the order summary panel, keep the checkout interface as it is, and leave the stored order schema alone.
  - Done when: `bun test src/steps/summary.spec.ts` exits 0 and the old code path is gone.
  - Depends: 6
- [ ] 8. Add inline validation errors
  - File: `src/validation.ts`
  - Do: Add inline validation errors, keep the checkout interface as it is, and leave the stored order schema alone.
  - Done when: `bun test src/validation.spec.ts` exits 0 and the old code path is gone.
  - Depends: 7
- [ ] 9. Persist the draft order
  - File: `src/draft.ts`
  - Do: Persist the draft order, keep the checkout interface as it is, and leave the stored order schema alone.
  - Done when: `bun test src/draft.spec.ts` exits 0 and the old code path is gone.
  - Depends: 8
- [ ] 10. Cover the flow with e2e tests
  - File: `e2e/checkout.spec.ts`
  - Do: Cover the flow with e2e tests, keep the checkout interface as it is, and leave the stored order schema alone.
  - Done when: `bun test e2e/checkout.spec.ts` exits 0 and the old code path is gone.
  - Depends: 9

### Rollout

- [ ] 11. Add the checkout feature flag
  - File: `src/flags.ts`
  - Do: Add the checkout feature flag, keep the checkout interface as it is, and leave the stored order schema alone.
  - Done when: `bun test src/flags.spec.ts` exits 0 and the old code path is gone.
  - Depends: 10
- [ ] 12. Write the migration notes
  - File: `docs/checkout-migration.md`
  - Do: Write the migration notes, keep the checkout interface as it is, and leave the stored order schema alone.
  - Done when: `bun test docs/checkout-migration.spec.ts` exits 0 and the old code path is gone.
  - Depends: 11
- [ ] 13. Run the load test
  - File: `bench/checkout.ts`
  - Do: Run the load test, keep the checkout interface as it is, and leave the stored order schema alone.
  - Done when: `bun test bench/checkout.spec.ts` exits 0 and the old code path is gone.
  - Depends: 12
- [ ] 14. Remove the old checkout page
  - File: `src/pages/old-checkout.tsx`
  - Do: Remove the old checkout page, keep the checkout interface as it is, and leave the stored order schema alone.
  - Done when: `bun test src/pages/old-checkout.spec.ts` exits 0 and the old code path is gone.
  - Depends: 13
