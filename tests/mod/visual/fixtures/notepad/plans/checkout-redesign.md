# Checkout redesign

Move the checkout to a single page with an order summary panel and saved payment methods.

## TODOs

### Milestone 1: Summary panel

- [x] 1. Extract the cart totals into a pure module
  - Do: move tax and shipping math out of `CheckoutPage`.
- [x] 2. Wire the order summary panel
  - Do: render totals from the pure module.
- [ ] 3. Show the saved payment methods
  - Do: list the customer's cards with the default first.
- [ ] 4. Record the final verification
  - Do: run `just ci` and log it.
