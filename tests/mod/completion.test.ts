import type { On } from "claude-code";
import { type Engine, type EngineCall, expect, test } from "claude-code/testing";
import { world } from "./world.ts";

const typed = ($: Engine, text: string) => {
  const start = text.lastIndexOf(" ") + 1;
  const prompt: { fill: unknown; autocomplete?: EngineCall<"prompt.autocomplete"> } = $.prompt;
  if (prompt.autocomplete === undefined) throw new Error("this engine offers no $.prompt.autocomplete");
  return prompt.autocomplete({ text, cursor: text.length, token: text.slice(start), start });
};

const typeahead = (on: On, below: readonly string[] = []) => on("prompt.autocomplete", () => ({ suggestions: below.map((text) => ({ text })) }));

const texts = (result: { suggestions: readonly { text: string }[] }) => result.suggestions.map((row) => row.text);

test("after /omca the typeahead offers the subcommands the token begins, each with what it does, after the rows beneath", async ($, on) => {
  world(on);
  typeahead(on, ["dev"]);

  expect((await typed($, "/omca d")).suggestions).toEqual([{ text: "dev" }, { text: "doctor", description: "Check the environment" }]);
  expect(texts(await typed($, "/omca s"))).toEqual(["dev", "stats"]);
  expect(texts(await typed($, "/omca plan"))).toEqual(["dev"]);
});

test("a word after a subcommand, or outside /omca, gets nothing", async ($, on) => {
  world(on);
  typeahead(on);

  expect(texts(await typed($, "/omca stats d"))).toEqual([]);
  expect(texts(await typed($, "/omca plan b"))).toEqual([]);
  expect(texts(await typed($, "please run d"))).toEqual([]);
});
