export type Mode = { readonly name: string; readonly banner: string };
type KeywordMode = Mode & { readonly pattern: RegExp };

export const KEYWORD_MODES: readonly KeywordMode[] = [
  {
    name: "handoff",
    pattern: /handoff|context\s+is\s+getting\s+long|start\s+fresh\s+session/,
    banner:
      "[HANDOFF MODE DETECTED] Handoff is user-driven and its skill cannot be model-invoked: suggest running /oh-my-claudeagent:handoff instead of improvising a summary.",
  },
  {
    name: "omca-setup",
    pattern: /setup\s+omca|omca\s+setup/,
    banner: "[OMCA-SETUP DETECTED] Run /oh-my-claudeagent:omca-setup to configure the environment.",
  },
  {
    name: "metis",
    pattern: /run\s+metis|metis\s+analyze|pre-plan/,
    banner: "[METIS DETECTED] Invoke /oh-my-claudeagent:metis for pre-planning analysis.",
  },
  {
    name: "plan",
    pattern: /run\s+prometheus|prometheus\s+plan|create\s+plan/,
    banner: "[PROMETHEUS DETECTED] Invoke /oh-my-claudeagent:plan for strategic planning via prometheus.",
  },
  {
    name: "hephaestus",
    pattern: /run\s+hephaestus|hephaestus\s+fix|fix\s+build|build\s+broken/,
    banner: "[HEPHAESTUS DETECTED] Invoke /oh-my-claudeagent:hephaestus to fix build failures.",
  },
];

export const SLASH_MODES: ReadonlyMap<string, Mode> = new Map([
  [
    "oh-my-claudeagent:handoff",
    {
      name: "handoff",
      banner: "[HANDOFF MODE ACTIVATED via slash command] Create session handoff summary for new-session continuity.",
    },
  ],
]);

const PASTE_OPEN = /^<pasted_content id="[^"]*">$/;
const PASTE_CLOSE = /^<\/pasted_content id="[^"]*">$/;
const NOTIFICATION_WINDOW = 500;
const META_CUE = /the\s+(phrase|keyword|trigger|literal)|trigger\s+phrase|document\s+that|do\s+not\s+run|don.t\s+run/;

function withoutPastes(prompt: string): string {
  let isPasted = false;
  return prompt
    .split(/\r?\n/)
    .filter((line) => {
      if (PASTE_OPEN.test(line)) {
        isPasted = true;
        return false;
      }
      if (PASTE_CLOSE.test(line)) {
        isPasted = false;
        return false;
      }
      return !isPasted;
    })
    .join("\n");
}

/**
 * The modes a prompt asks for. Text that mentions a phrase is not asking for it, so the
 * matcher errs toward silence: a missed banner costs a slash command the user can still
 * type, a false one derails the turn. Pasted text, background-agent relays, prompts that
 * discuss their own trigger phrases, and double-quoted or backticked spans never match;
 * single quotes are left alone because apostrophes make a single-quoted span unparseable.
 */
export function matchKeywordModes(prompt: string): readonly KeywordMode[] {
  const typed = withoutPastes(prompt);
  if (typed.slice(0, NOTIFICATION_WINDOW).includes("<task-notification>")) return [];
  const lower = typed.toLowerCase();
  if (META_CUE.test(lower)) return [];
  const uncited = lower.replace(/"[^"\n]*"/g, " ").replace(/`[^`\n]*`/g, " ");
  return KEYWORD_MODES.filter(({ pattern }) => pattern.test(uncited));
}
