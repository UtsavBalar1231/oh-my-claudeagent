// Matches `- [ ] 1.` and `- [x] 12.`; the single definition of a numbered task.
const CHECKBOX_RE = /^- \[([ x])\] \d+\./gm;

/** The state (`"x"` or `" "`) of each numbered checkbox, in document order. */
export function checkboxStates(content: string): string[] {
  return Array.from(content.matchAll(CHECKBOX_RE), (m) => m[1] ?? "");
}

const CHECKBOX_LABEL_RE = /^- \[([ x])\] \d+\.\s*(.*)$/gm;

// Keeps the label a short resume hint rather than a restatement of the task.
export const MAX_LABEL_LEN = 80;

export function nextTaskLabel(content: string): string | null {
  for (const [, state, text] of content.matchAll(CHECKBOX_LABEL_RE)) {
    if (state === "x") continue;
    // Code points, not UTF-16 units, so a label cut mid-emoji keeps its length.
    const chars = Array.from((text ?? "").trim());
    if (chars.length <= MAX_LABEL_LEN) return chars.join("");
    return `${chars.slice(0, MAX_LABEL_LEN - 1).join("").trimEnd()}…`;
  }
  return null;
}

/** A plan with no numbered checkboxes is never complete. */
export function planIsComplete(content: string): boolean {
  const states = checkboxStates(content);
  return states.length > 0 && states.every((s) => s === "x");
}
