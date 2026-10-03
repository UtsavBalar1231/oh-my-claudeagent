export type ReferenceFile = { path: string; content: string; existing: boolean };

export const REFERENCE: Readonly<Record<string, readonly ReferenceFile[]>> = {
  bugfix: [
    {
      path: "src/slugify.ts",
      existing: true,
      content: `export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
`,
    },
  ],
  "feature-with-tests": [
    {
      path: "src/duration.ts",
      existing: false,
      content: `const PATTERN = /^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?$/;

export function parseDuration(input: string): number {
  const match = PATTERN.exec(input);
  if (match === null || input === "") throw new Error(\`invalid duration: \${input}\`);
  const [, hours = "0", minutes = "0", seconds = "0"] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}
`,
    },
    {
      path: "test/duration.test.ts",
      existing: false,
      content: `import { expect, test } from "bun:test";
import { parseDuration } from "../src/duration.ts";

test("parses hours and minutes", () => {
  expect(parseDuration("1h30m")).toBe(5400);
});

test("parses a single unit", () => {
  expect(parseDuration("45s")).toBe(45);
});

test("rejects an empty string", () => {
  expect(() => parseDuration("")).toThrow();
});
`,
    },
  ],
  refactor: [
    {
      path: "src/pricing.ts",
      existing: true,
      content: `function discounted(subtotal: number, rate: number): number {
  return Math.round(subtotal * (1 - rate) * 100) / 100;
}

export function applyBulkDiscount(subtotal: number, quantity: number): number {
  return discounted(subtotal, quantity >= 100 ? 0.15 : quantity >= 10 ? 0.1 : 0);
}

export function applyMemberDiscount(subtotal: number, years: number): number {
  return discounted(subtotal, Math.min(years, 5) * 0.02);
}
`,
    },
  ],
  "stop-before-verified": [
    {
      path: "src/title.ts",
      existing: true,
      content: `export function firstLine(text: string): string | null {
  return text === "" ? null : text.split("\\n")[0];
}
`,
    },
    {
      path: "src/banner.ts",
      existing: true,
      content: `import { firstLine } from "./title.ts";

export function banner(text: string): string {
  return firstLine(text)?.toUpperCase() ?? "";
}
`,
    },
  ],
  "plan-and-implement": [
    {
      path: "src/api.ts",
      existing: true,
      content: `export type User = { id: number; name: string };

export const USERS: User[] = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: \`user-\${i + 1}\` }));

export function handleList(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const offset = Number(params.get("offset") ?? 0);
  const limit = params.has("limit") ? Number(params.get("limit")) : USERS.length;
  return Response.json(USERS.slice(offset, offset + limit));
}
`,
    },
  ],
};
