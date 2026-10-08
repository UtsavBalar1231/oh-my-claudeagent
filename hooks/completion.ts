import { matching, RATING_WORDS, slotAt, SUBCOMMAND_WORDS, type Word } from "../src/core/completion.ts";
import type { Features } from "./dispatch.ts";
import type { Host } from "./host.ts";
import { planNames } from "./tabs/plan.ts";

async function wordsFor(host: Host, slot: NonNullable<ReturnType<typeof slotAt>>): Promise<readonly Word[]> {
  if (slot === "subcommand") return SUBCOMMAND_WORDS;
  if (slot === "rating") return RATING_WORDS;
  return (await planNames(host)).map((name) => ({ text: name }));
}

export const completion: Features = {
  "prompt.autocomplete": {
    async post(host, e, result) {
      const slot = slotAt(e.text, e.start);
      if (slot === undefined) return undefined;
      const mine = matching(await wordsFor(host, slot), e.token);
      return mine.length === 0 ? undefined : { suggestions: [...result.suggestions, ...mine] };
    },
  },
};
