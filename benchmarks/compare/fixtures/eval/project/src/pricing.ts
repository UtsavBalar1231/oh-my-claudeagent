export function applyBulkDiscount(subtotal: number, quantity: number): number {
  const rate = quantity >= 100 ? 0.15 : quantity >= 10 ? 0.1 : 0;
  return Math.round(subtotal * (1 - rate) * 100) / 100;
}

export function applyMemberDiscount(subtotal: number, years: number): number {
  const rate = Math.min(years, 5) * 0.02;
  return Math.round(subtotal * (1 - rate) * 100) / 100;
}
