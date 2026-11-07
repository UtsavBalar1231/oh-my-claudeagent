import { entriesOf, readLedger } from "../../src/core/evidence.ts";
import { isPlanName, NOTEPAD_SECTIONS, parseEntries } from "../../src/core/notepad.ts";
import { type Check, type Context, type Outcome, readText, skip, verdict } from "./core.ts";

const IN_FIXTURES = /(?:^|\/)fixtures\//;
const LEDGER = /\/\.omca\/evidence\/verification-evidence[^/]*\.json$/;
const NOTEPAD = /\/\.omca\/notepads\/([^/]+)\/([^/]+)\.md$/;

type Problem = string | undefined;

function ledgerProblem(text: string): Problem {
  const read = readLedger(text);
  if (read.kind === "refused") return read.reason;
  const listed = entriesOf(read.document);
  if (listed === undefined) return "it has no entries list";
  const skipped = listed.length - read.entries.length;
  return skipped === 0 ? undefined : `${skipped} of its entries are malformed`;
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
        if (problem !== undefined) problems.push(`${path}: ${problem}`);
      }
      return verdict(problems, `${files.length} fixtures read as the shared parsers expect`);
    },
  };
}

export const checks: readonly Check[] = [
  familyCheck("ledger fixtures", LEDGER, ledgerProblem),
  familyCheck("notepad fixtures", NOTEPAD, notepadProblem),
];
