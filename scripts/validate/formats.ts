import { entriesOf, readLedger } from "../../src/core/evidence.ts";
import { parseRegistry } from "../../src/core/boulder.ts";
import { FENCE, planTasks } from "../../src/core/checkboxes.ts";
import { isPlanName, NOTEPAD_SECTIONS, parseEntries } from "../../src/core/notepad.ts";
import { type Check, type Context, type Outcome, readText, skip, verdict } from "./core.ts";

/** Fixtures that exist to exercise a refusal. Each must still fail its check, so a loosened reader is caught. */
export const EXPECTED_INVALID: Readonly<Record<string, string>> = {
  "tests/fixtures/boulder-schemas/corrupt.json": "not JSON",
  "tests/fixtures/boulder-schemas/half-written.json": "a registry cut off mid-write",
  "tests/fixtures/boulder-schemas/old-flat.json": "the retired single-plan layout, which the reader takes for an empty registry",
};

const IN_FIXTURES = /(?:^|\/)fixtures\//;
const REGISTRY = /(?:^tests\/fixtures\/boulder-schemas\/[^/]+\.json|\/\.omca\/state\/boulder\.json)$/;
const LEDGER = /\/\.omca\/evidence\/verification-evidence[^/]*\.json$/;
const PLAN = /(?:^|\/)plans\/[^/]+\.md$/;
const NOTEPAD = /\/\.omca\/notepads\/([^/]+)\/([^/]+)\.md$/;

type Problem = string | undefined;

function registryProblem(text: string): Problem {
  const read = parseRegistry(text);
  if (read.kind === "refused") return read.reason;
  const document: unknown = JSON.parse(text);
  const keys = typeof document === "object" && document !== null ? Object.keys(document) : [];
  return keys.includes("plans") || keys.includes("bindings") ? undefined : "it has neither `plans` nor `bindings`";
}

function ledgerProblem(text: string): Problem {
  const read = readLedger(text);
  if (read.kind === "refused") return read.reason;
  const listed = entriesOf(read.document);
  if (listed === undefined) return "it has no entries list";
  const skipped = listed.length - read.entries.length;
  return skipped === 0 ? undefined : `${skipped} of its entries are malformed`;
}

function planProblem(text: string): Problem {
  if (planTasks(text).length > 0) return undefined;
  return text.split(/\r?\n/).some((line) => FENCE.test(line)) ? "its numbered tasks are all inside code fences" : "it has no numbered tasks";
}

function notepadProblem(text: string, path: string): Problem {
  const [, plan = "", section = ""] = NOTEPAD.exec(path) ?? [];
  if (!isPlanName(plan)) return `"${plan}" is not a plan name`;
  if (!(NOTEPAD_SECTIONS as readonly string[]).includes(section)) return `"${section}" is not a notepad section`;
  return parseEntries(text).length > 0 ? undefined : "it has no entries";
}

function familyCheck(name: string, pattern: RegExp, problemOf: (text: string, path: string) => Problem): Check {
  return {
    name,
    run(ctx: Context): Outcome {
      const files = ctx.tracked().filter((path) => pattern.test(path) && IN_FIXTURES.test(path));
      if (files.length === 0) return skip("no committed fixtures in this tree");
      const problems: string[] = [];
      for (const path of files) {
        const problem = problemOf(readText(ctx.root, path), path);
        if (path in EXPECTED_INVALID) {
          if (problem === undefined) problems.push(`${path} is listed as invalid on purpose but is valid`);
        } else if (problem !== undefined) {
          problems.push(`${path}: ${problem}`);
        }
      }
      return verdict(problems, `${files.length} fixtures read as the shared parsers expect`);
    },
  };
}

export const checks: readonly Check[] = [
  familyCheck("registry fixtures", REGISTRY, registryProblem),
  familyCheck("ledger fixtures", LEDGER, ledgerProblem),
  familyCheck("plan fixtures", PLAN, planProblem),
  familyCheck("notepad fixtures", NOTEPAD, notepadProblem),
];
