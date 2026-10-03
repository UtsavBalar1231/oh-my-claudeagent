# Ship the checkout redesign

**Scope**: about 30 files | **Parallel Execution**: YES - 3 waves | **Status**: FINAL

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
  - File: `src/cart/totals.ts`
  - Do: Sum line items, discounts and shipping in integer cents.
  - Done when: `bun test src/cart` exits 0.
  - Depends: none
- [x] 2. Move tax rates into config
  - File: `src/cart/tax.ts`, `config/tax.json`
  - Do: Read the rate for each region from `config/tax.json` instead of constants.
  - Done when: `bun test src/cart` exits 0.
  - Depends: 1
- [x] 3. Add the address form schema
  - File: `src/forms/address.ts`
  - Do: Describe each address field with its rule and its error text.
  - Done when: `bun test src/forms` exits 0.
  - Depends: none
- [x] 4. Add the card form schema
  - File: `src/forms/card.ts`
  - Do: Validate the card number, expiry and CVC on the client, never storing them.
  - Done when: `bun test src/forms` exits 0.
  - Depends: 3

### Checkout flow

- [x] 5. Build the address step
  - File: `src/steps/address.ts`
  - Do: One screen for shipping and billing, with billing copied from shipping by default.
  - Done when: `bun test src/steps` exits 0.
  - Depends: 3
- [x] 6. Build the payment step
  - File: `src/steps/payment.ts`
  - Do: Keep the cart when a card is declined and show the reason beside the card field.
  - Done when: `bun test src/steps` exits 0.
  - Depends: 4, 5
- [ ] 7. Wire the order summary panel
  - File: `src/steps/summary.ts`, `src/steps/summary.spec.ts`
  - Do: Show items, tax and shipping beside the payment step, read from the totals module.
  - Done when: `bun test src/steps/summary.spec.ts` exits 0.
  - Depends: 1, 6
- [ ] 8. Add inline validation errors
  - File: `src/forms/errors.ts` (new)
  - Do: Show each field's error under the field as soon as it loses focus.
  - Done when: `bun test src/forms` exits 0.
  - Depends: 3, 4
- [ ] 9. Persist the draft order
  - File: `src/cart/draft.ts` (new)
  - Do: Save the draft order on every step so a reload or a declined card keeps it.
  - Done when: `bun test src/cart` exits 0.
  - Depends: 1
- [ ] 10. Cover the flow with e2e tests
  - File: `e2e/checkout.spec.ts` (new)
  - Do: Walk all three steps, including a declined card and a reload mid-flow.
  - Done when: `just e2e` exits 0.
  - Depends: 7, 8, 9

### Rollout

- [ ] 11. Add the checkout feature flag
  - File: `src/flags.ts` (new)
  - Do: Serve the new checkout to staff first, then to a share of customers.
  - Done when: `bun test src/flags.spec.ts` exits 0.
  - Depends: none
- [ ] 12. Run the load test
  - File: `bench/checkout.ts` (new)
  - Do: Hold 200 checkouts a minute for ten minutes against staging.
  - Done when: p95 stays under 400 ms.
  - Depends: 10
- [ ] 13. Write the migration notes
  - File: `docs/checkout-migration.md` (new)
  - Do: Tell support what changed and how to turn the flag off.
  - Done when: support signs off.
  - Depends: 11
- [ ] 14. Remove the old checkout page
  - File: `src/pages/old-checkout.tsx`
  - Do: Delete the page and its route once the flag is on for everyone.
  - Done when: `just ci` exits 0.
  - Depends: 12, 13

## Verification
- `just ci` exits 0.
- A declined card keeps the cart on staging.
