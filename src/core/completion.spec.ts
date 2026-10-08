import { expect, test } from "bun:test";
import { matching, slotAt, SUBCOMMAND_WORDS } from "./completion.ts";

const at = (draft: string) => slotAt(draft, draft.lastIndexOf(" ") + 1);

test("the token after /omca is a subcommand, and after /omca plan a plan name", () => {
  expect(at("/omca d")).toBe("subcommand");
  expect(at("  /omca   st")).toBe("subcommand");
  expect(at("/omca plan bill")).toBe("plan");
});

test("no other token is an OMCA argument", () => {
  expect(at("/omca plan billing more")).toBeUndefined();
  expect(at("/omca stats extra")).toBeUndefined();
  expect(at("tell /omca d")).toBeUndefined();
  expect(at("/omcax d")).toBeUndefined();
  expect(slotAt("/omca", 0)).toBeUndefined();
});

test("the words that begin with the token, case aside, leave out the one typed in full", () => {
  expect(matching(SUBCOMMAND_WORDS, "d").map((word) => word.text)).toEqual(["doctor"]);
  expect(matching(SUBCOMMAND_WORDS, "S").map((word) => word.text)).toEqual(["stats"]);
  expect(matching(SUBCOMMAND_WORDS, "plan")).toEqual([]);
  expect(matching(SUBCOMMAND_WORDS, "x")).toEqual([]);
});
