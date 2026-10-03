
## 2026-10-01T09:42:10Z

The cart totals were computed in three places. `CheckoutPage`, `OrderEmail` and the receipt PDF now all call `totals(cart)` from `src/cart/totals.ts`.

## 2026-10-02T11:05:44Z

- Tax rounds **per line**, not per order; the old code rounded once and drifted by a cent.
- Shipping is free from $50.00 after discounts, so `discount` runs before `shipping`.

## 2026-10-03T08:17:02Z

The staging gateway rejects amounts with more than two decimals. `formatMinor()` converts before every request.
