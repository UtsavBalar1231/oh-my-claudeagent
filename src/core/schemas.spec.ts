import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tools as boulderTools } from "../../servers/tools/boulder.ts";
import { tools as evidenceTools } from "../../servers/tools/evidence.ts";
import { EVIDENCE_TYPES } from "./evidence.ts";
import { STATE_VERSION } from "./state-version.ts";

type Schema = {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: boolean | Schema;
};
type Json = Record<string, unknown>;

const DOCS = join(import.meta.dir, "../../docs");
const schemaOf = (name: string): Schema => JSON.parse(readFileSync(join(DOCS, "schemas", name), "utf8"));
const LEDGER = schemaOf("evidence-ledger.v1.schema.json");
const REGISTRY = schemaOf("plan-registry.v1.schema.json");

const jsonType = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
};

const isOfType = (type: string, value: unknown): boolean => jsonType(value) === type || (type === "number" && jsonType(value) === "integer");

/** The `type`, `required`, `enum`, `const`, `properties`, `items` and `additionalProperties` rules; every other keyword is ignored. */
function validate(schema: Schema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  if (schema.type !== undefined && !isOfType(schema.type, value)) return [`${path} is ${jsonType(value)}, expected ${schema.type}`];
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path} is not ${JSON.stringify(schema.const)}`);
  if (schema.enum !== undefined && !schema.enum.includes(value)) errors.push(`${path} is not one of ${schema.enum.join(", ")}`);
  if (Array.isArray(value) && schema.items !== undefined) {
    for (const [index, item] of value.entries()) errors.push(...validate(schema.items, item, `${path}[${index}]`));
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const object = value as Json;
    for (const key of schema.required ?? []) if (!(key in object)) errors.push(`${path}.${key} is required`);
    for (const [key, child] of Object.entries(object)) {
      const known = schema.properties?.[key];
      if (known !== undefined) errors.push(...validate(known, child, `${path}.${key}`));
      else if (typeof schema.additionalProperties === "object") errors.push(...validate(schema.additionalProperties, child, `${path}.${key}`));
    }
  }
  return errors;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omca-schemas-")));
  roots.push(root);
  expect(Bun.spawnSync(["git", "init", "-q", root], { env: process.env }).exitCode).toBe(0);
  return root;
}

const callTool = async (tools: { name: string; call: (args: Record<string, unknown>) => unknown }[], name: string, args: Record<string, unknown>) => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  await tool.call(args);
};

const PLAN_SHA = "ab".repeat(32);

async function writtenLedger(): Promise<Json> {
  const root = project();
  const base = { evidence_type: "test", command: "just test", exit_code: 0, output_snippet: "5 passed", working_directory: root };
  await callTool(evidenceTools, "evidence_log", base);
  await callTool(evidenceTools, "evidence_log", { ...base, evidence_type: "final_verification", verified_by: "executor", plan_sha256: PLAN_SHA });
  return JSON.parse(readFileSync(join(root, ".omca", "evidence", "verification-evidence.json"), "utf8"));
}

async function writtenRegistry(): Promise<Json> {
  const root = project();
  const plan = { active_plan: "/home/user/plan.md", working_directory: root };
  await callTool(boulderTools, "boulder_write", { ...plan, plan_name: "plain", session_id: "session-one" });
  await callTool(boulderTools, "boulder_write", { ...plan, plan_name: "tree", session_id: "session-two", worktree_path: "/home/user/tree" });
  return JSON.parse(readFileSync(join(root, ".omca", "state", "boulder.json"), "utf8"));
}

const keysOf = (objects: readonly Json[]): string[] => [...new Set(objects.flatMap((object) => Object.keys(object)))].sort();
const alwaysIn = (objects: readonly Json[]): string[] => keysOf(objects).filter((key) => objects.every((object) => key in object));

/** The schema's property names are the keys the writer emits, its `required` is the keys it always emits less `version`, and each `type` fits the values. */
function expectMatches(schema: Schema, written: readonly Json[], { optional = [] }: { optional?: string[] } = {}): void {
  const properties = schema.properties ?? {};
  expect(Object.keys(properties).sort()).toEqual(keysOf(written));
  expect([...(schema.required ?? []), ...optional].sort()).toEqual(alwaysIn(written));
  for (const object of written) {
    for (const [key, value] of Object.entries(object)) expect(isOfType(properties[key]?.type ?? "", value)).toBe(true);
  }
}

describe("evidence ledger schema", () => {
  test("names the keys, types and requirements the writer emits", async () => {
    const ledger = await writtenLedger();
    expectMatches(LEDGER, [ledger], { optional: ["version"] });
    const entries = ledger["entries"] as Json[];
    expect(entries).toHaveLength(2);
    expectMatches(LEDGER.properties?.["entries"]?.items ?? {}, entries);
    expect(entries.map((entry) => Object.keys(entry).length)).toEqual([5, 7]);
  });

  test("holds the writer's version and entry types", () => {
    expect(LEDGER.properties?.["version"]?.const).toBe(STATE_VERSION);
    expect(LEDGER.properties?.["entries"]?.items?.properties?.["type"]?.enum).toEqual([...EVIDENCE_TYPES]);
  });

  test("accepts what the writer wrote", async () => {
    expect(validate(LEDGER, await writtenLedger())).toEqual([]);
  });

  test("rejects an entry that lacks a required field", async () => {
    const ledger = await writtenLedger();
    const [entry] = ledger["entries"] as Json[];
    const required = LEDGER.properties?.["entries"]?.items?.required ?? [];
    expect(required.length).toBeGreaterThan(0);
    for (const field of required) {
      const { [field]: _dropped, ...rest } = entry as Json;
      expect(validate(LEDGER, { ...ledger, entries: [rest] })).toEqual([`$.entries[0].${field} is required`]);
    }
  });

  test("rejects a wrong type, an unknown evidence type, a wrong version and a missing entries list", async () => {
    const ledger = await writtenLedger();
    const [entry] = ledger["entries"] as Json[];
    expect(validate(LEDGER, { ...ledger, entries: [{ ...entry, exit_code: "0" }] })).toEqual(["$.entries[0].exit_code is string, expected integer"]);
    expect(validate(LEDGER, { ...ledger, entries: [{ ...entry, type: "deploy" }] })).toHaveLength(1);
    expect(validate(LEDGER, { ...ledger, version: 2 })).toEqual(["$.version is not 1"]);
    expect(validate(LEDGER, { version: 1 })).toEqual(["$.entries is required"]);
  });

  test("allows unknown keys, as the reader keeps them", async () => {
    const ledger = await writtenLedger();
    expect(validate(LEDGER, { ...ledger, note: "kept" })).toEqual([]);
  });
});

describe("plan registry schema", () => {
  test("names the keys, types and requirements the writer emits", async () => {
    const registry = await writtenRegistry();
    expectMatches(REGISTRY, [registry], { optional: ["version"] });
    const plans = Object.values(registry["plans"] as Record<string, Json>);
    const bindings = Object.values(registry["bindings"] as Record<string, Json>);
    expect(plans).toHaveLength(2);
    expect(bindings).toHaveLength(2);
    const planSchema = REGISTRY.properties?.["plans"]?.additionalProperties as Schema;
    const bindingSchema = REGISTRY.properties?.["bindings"]?.additionalProperties as Schema;
    expectMatches(planSchema, plans);
    expectMatches(bindingSchema, bindings);
    expect(planSchema.properties?.["session_ids"]?.items?.type).toBe("string");
  });

  test("holds the writer's version", () => {
    expect(REGISTRY.properties?.["version"]?.const).toBe(STATE_VERSION);
  });

  test("accepts what the writer wrote", async () => {
    expect(validate(REGISTRY, await writtenRegistry())).toEqual([]);
  });

  test("rejects an entry that lacks a required field", async () => {
    const registry = await writtenRegistry();
    const plan = (registry["plans"] as Record<string, Json>)["plain"] as Json;
    const binding = (registry["bindings"] as Record<string, Json>)["session-one"] as Json;
    for (const field of ["active_plan", "started_at", "session_ids"]) {
      const { [field]: _dropped, ...rest } = plan;
      expect(validate(REGISTRY, { ...registry, plans: { plain: rest } })).toEqual([`$.plans.plain.${field} is required`]);
    }
    for (const field of ["plan_name", "bound_at"]) {
      const { [field]: _dropped, ...rest } = binding;
      expect(validate(REGISTRY, { ...registry, bindings: { one: rest } })).toEqual([`$.bindings.one.${field} is required`]);
    }
    expect(validate(REGISTRY, { version: 1, plans: {} })).toEqual(["$.bindings is required"]);
  });
});

describe("docs/formats.md examples", () => {
  const JSON_BLOCK = /```json\n([\s\S]*?)```/g;
  const examples = [...readFileSync(join(DOCS, "formats.md"), "utf8").matchAll(JSON_BLOCK)].map((match) => JSON.parse(match[1] ?? "") as Json);

  test("each document example satisfies its schema", () => {
    const documents = examples.filter((example) => "entries" in example || "plans" in example);
    expect(documents.map((example) => ("entries" in example ? "ledger" : "registry"))).toEqual(["ledger", "registry"]);
    for (const example of documents) expect(validate("entries" in example ? LEDGER : REGISTRY, example)).toEqual([]);
  });
});
