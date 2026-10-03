#!/usr/bin/env bash
# A small bun project in a git repository, shared by the context cases.
set -euo pipefail
mkdir -p src
cat > package.json <<'JSON'
{ "name": "shop", "private": true, "type": "module", "scripts": { "test": "bun test" } }
JSON
cat > src/pricing.ts <<'TS'
export type Line = { price: number; quantity: number };

export function subtotal(lines: Line[]): number {
  return lines.reduce((sum, line) => sum + line.price * line.quantity, 0);
}

export function applyBulkDiscount(total: number, items: number): number {
  return items >= 10 ? Math.round(total * 90) / 100 : total;
}
TS
cat > src/cart.ts <<'TS'
import { applyBulkDiscount, type Line, subtotal } from "./pricing.ts";

export function cartTotal(lines: Line[]): number {
  const items = lines.reduce((count, line) => count + line.quantity, 0);
  return applyBulkDiscount(subtotal(lines), items);
}
TS
cat > src/pricing.test.ts <<'TS'
import { expect, test } from "bun:test";
import { applyBulkDiscount, subtotal } from "./pricing.ts";

test("subtotal adds price times quantity", () => {
  expect(subtotal([{ price: 2, quantity: 3 }, { price: 5, quantity: 1 }])).toBe(11);
});

test("ten or more items take ten percent off", () => {
  expect(applyBulkDiscount(100, 10)).toBe(90);
  expect(applyBulkDiscount(100, 9)).toBe(100);
});
TS
printf '# shop\n\nCart and pricing helpers. Run `bun test`.\n' > README.md
git init -q
git add -A
git -c user.email=eval@example.invalid -c user.name=eval commit -qm "Initial commit"
