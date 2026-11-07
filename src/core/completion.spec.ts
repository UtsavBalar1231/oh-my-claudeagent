import { expect, test } from "bun:test";
import { isSubcommandSlot, matching, SUBCOMMAND_WORDS } from "./completion.ts";

const at = (draft: string) => isSubcommandSlot(draft, draft.lastIndexOf(" ") + 1);

test("the token after /omca is a subcommand", () => {
  expect(at("/omca d")).toBe(true);
  expect(at("  /omca   st")).toBe(true);
});

test("no other token is an OMCA argument", () => {
  expect(at("/omca stats extra")).toBe(false);
  expect(at("tell /omca d")).toBe(false);
  expect(at("/omcax d")).toBe(false);
  expect(isSubcommandSlot("/omca", 0)).toBe(false);
});

test("the words that begin with the token, case aside, leave out the one typed in full", () => {
  expect(matching(SUBCOMMAND_WORDS, "d").map((word) => word.text)).toEqual(["doctor"]);
  expect(matching(SUBCOMMAND_WORDS, "S").map((word) => word.text)).toEqual(["stats"]);
  expect(matching(SUBCOMMAND_WORDS, "stats")).toEqual([]);
  expect(matching(SUBCOMMAND_WORDS, "plan")).toEqual([]);
  expect(matching(SUBCOMMAND_WORDS, "x")).toEqual([]);
});
