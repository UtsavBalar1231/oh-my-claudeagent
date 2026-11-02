import type { PromptDecoration } from "claude-code";
import { isHookDisabled } from "../src/core/kill-switch.ts";
import { isSlashCommand, keywordSpans, matchKeywordModes } from "../src/core/keywords.ts";
import type { Features } from "./dispatch.ts";
import type { Host } from "./host.ts";

let isActive = false;
// The server's detector announces each mode once a session, so a phrase that has fired stops being marked.
const announced = new Set<string>();

// An underline alone keeps the theme's text color, which every theme makes readable.
function decorationsFor(text: string): PromptDecoration[] {
  if (isSlashCommand(text)) return [];
  return keywordSpans(text)
    .filter(({ name }) => !announced.has(name))
    .map(({ start, end }) => ({ start, end, underline: true }));
}

async function repaint(host: Host): Promise<void> {
  const { text } = await host.prompt.read();
  await host.prompt.paint({ text, decorations: decorationsFor(text) });
}

export const keywordPaint: Features = {
  "session.start": {
    post: async (host) => {
      announced.clear();
      isActive = host.options.enableKeywordTriggers && !isHookDisabled(await host.env.OMCA_DISABLED_HOOKS(), "keyword-detector");
      return undefined;
    },
  },
  "prompt.submit": {
    pre(_host, e) {
      if (isActive && !isSlashCommand(e.text)) for (const { name } of matchKeywordModes(e.text)) announced.add(name);
      return undefined;
    },
  },
  // Typing answers with the draft's runs, which the box keeps on the same characters until the next answer.
  "prompt.edit": {
    post: (_host, _e, result) => {
      if (!isActive) return undefined;
      const mine = decorationsFor(result.text);
      return mine.length === 0 ? undefined : { ...result, decorations: [...(result.decorations ?? []), ...mine] };
    },
  },
  // A recalled entry, an undo or a fill raises no edit, so nothing answers with runs for it.
  "prompt.change": {
    post: async (host) => {
      if (isActive) await repaint(host);
      return undefined;
    },
  },
};
