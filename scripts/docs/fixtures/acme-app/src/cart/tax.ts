import { readFileSync } from "node:fs";

const rates: Record<string, number> = JSON.parse(readFileSync(new URL("../../config/tax.json", import.meta.url), "utf8"));

export const taxCents = (region: string, cents: number) => Math.round(cents * (rates[region] ?? 0));
