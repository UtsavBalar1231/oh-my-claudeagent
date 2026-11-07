import { isSubcommandSlot, matching, SUBCOMMAND_WORDS } from "../src/core/completion.ts";
import type { Features } from "./dispatch.ts";

export const completion: Features = {
  "prompt.autocomplete": {
    post(_host, e, result) {
      if (!isSubcommandSlot(e.text, e.start)) return undefined;
      const mine = matching(SUBCOMMAND_WORDS, e.token);
      return mine.length === 0 ? undefined : { suggestions: [...result.suggestions, ...mine] };
    },
  },
};
