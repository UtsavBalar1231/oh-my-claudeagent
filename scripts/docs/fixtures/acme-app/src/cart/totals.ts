export type Line = { cents: number; quantity: number };

export const subtotal = (lines: readonly Line[]) => lines.reduce((sum, line) => sum + line.cents * line.quantity, 0);

export const total = (lines: readonly Line[], discountCents: number, shippingCents: number) =>
  Math.max(0, subtotal(lines) - discountCents) + shippingCents;
