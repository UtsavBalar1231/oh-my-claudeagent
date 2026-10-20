export function total(items: { price: number; qty: number }[]): number {
  return items.reduce((sum, item) => sum + item.price, 0);
}
