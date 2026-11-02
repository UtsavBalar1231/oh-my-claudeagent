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
    name: "analyzer",
    pattern: /\brun\s+analyzer\b|\banalyze\s+(the\s+)?plan\b|pre-plan/,
    banner: "[ANALYZER DETECTED] Invoke /oh-my-claudeagent:analyzer for pre-planning analysis.",
  },
  {
    name: "plan",
    pattern: /\brun\s+planner\b|create\s+plan/,
    banner: "[PLAN DETECTED] Invoke /oh-my-claudeagent:plan for strategic planning via the planner.",
  },
  {
    name: "build-fixer",
    pattern: /\brun\s+build-fixer\b|fix\s+build|build\s+broken/,
    banner: "[BUILD-FIXER DETECTED] Invoke /oh-my-claudeagent:build-fixer to fix build failures.",
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

const blank = (text: string): string => " ".repeat(text.length);

function blankPastes(prompt: string): string {
  let isPasted = false;
  return prompt
    .split("\n")
    .map((line) => {
      const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (PASTE_OPEN.test(bare)) {
        isPasted = true;
        return blank(line);
      }
      if (PASTE_CLOSE.test(bare)) {
        isPasted = false;
        return blank(line);
      }
      return isPasted ? blank(line) : line;
    })
    .join("\n");
}

/**
 * What in a prompt can ask for a mode, lowercased, and null when none of it can. Text that mentions
 * a phrase is not asking for it, so the matcher errs toward silence: a missed banner costs a slash
 * command the user can still type, a false one derails the turn. Pasted text, background-agent
 * relays, prompts that discuss their own trigger phrases, and double-quoted or backticked spans never
 * match; single quotes are left alone because apostrophes make a single-quoted span unparseable.
 * Each blank is as wide as what it hides and only ASCII letters change case, so an offset here is an
 * offset into the prompt.
 */
function askingText(prompt: string): string | null {
  const typed = blankPastes(prompt);
  if (typed.slice(0, NOTIFICATION_WINDOW).includes("<task-notification>")) return null;
  const lower = typed.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
  if (META_CUE.test(lower)) return null;
  return lower.replace(/"[^"\n]*"/g, blank).replace(/`[^`\n]*`/g, blank);
}

/** The modes a prompt asks for. */
export function matchKeywordModes(prompt: string): readonly KeywordMode[] {
  const asking = askingText(prompt);
  return asking === null ? [] : KEYWORD_MODES.filter(({ pattern }) => pattern.test(asking));
}

export type KeywordSpan = { name: string; start: number; end: number };

/** Where a prompt asks for each mode, by offset into the prompt, so a draft can show what will fire. */
export function keywordSpans(prompt: string): readonly KeywordSpan[] {
  const asking = askingText(prompt);
  if (asking === null) return [];
  return KEYWORD_MODES.flatMap(({ name, pattern }) =>
    [...asking.matchAll(new RegExp(pattern.source, "g"))].map((match) => ({ name, start: match.index, end: match.index + match[0].length })),
  ).toSorted((a, b) => a.start - b.start);
}

const SLASH_COMMAND = /^\s*\/[\w:.-]+(?:\s|$)/;

/** A prompt that runs a slash command, which the keyword detector leaves alone. */
export const isSlashCommand = (prompt: string): boolean => SLASH_COMMAND.test(prompt);
