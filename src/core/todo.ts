/** True when the text names an issue (`#12`, `PROJ-34`) or a person (`@alice`). */
export const hasReference = (text: string): boolean => /#\d+|[A-Z]+-\d+|@[A-Za-z]/.test(text);

const PLACEHOLDER = /todo:\s*implement\w*\b(.*)$/i;
const MIN_CONTEXT_WORDS = 3;

/**
 * True when a line holds a bare `TODO: implement`: no issue or owner reference, and fewer than
 * three words after `implement`. One that goes on to say what and why is a plan, not a stub.
 */
export const isPlaceholderTodo = (text: string): boolean =>
  text.split("\n").some((line) => {
    const rest = PLACEHOLDER.exec(line)?.[1];
    return rest !== undefined && !hasReference(line) && rest.trim().split(/\s+/).filter(Boolean).length < MIN_CONTEXT_WORDS;
  });
