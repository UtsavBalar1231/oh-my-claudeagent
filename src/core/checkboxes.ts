export const FENCE = /^\s*(```|~~~)/;
const TAB = 9;
const NEWLINE = 10;

// Filtered by char code: the engine's parser refuses a regex literal holding `\u0000`-style
// escapes and fails the whole module.
function isUnsafe(code: number): boolean {
  return (
    (code < 32 && code !== TAB && code !== NEWLINE) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff
  );
}

/** CRLF folded to LF and control or invisible characters dropped, so every reader sees one text. */
export function clean(text: string): string {
  let out = "";
  for (const char of text.replace(/\r\n?/g, "\n")) {
    if (!isUnsafe(char.codePointAt(0) ?? 0)) out += char;
  }
  return out;
}

/** The text with fenced code blocks and their fence lines blanked, so an example task is not a task. Line count is kept. */
export function outsideFences(text: string): string {
  let inFence = false;
  return clean(text)
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence;
        return "";
      }
      return inFence ? "" : line;
    })
    .join("\n");
}

/** One numbered task line (`- [ ] 1. text`, `- [x] 12. text`): the definition every plan reader shares. */
export const TASK_LINE = /^- \[([ x])\] (\d+)\.\s*(.*)$/;

/** The numbered task lines outside code fences, in document order, as `TASK_LINE` matches. */
export const taskLines = (content: string): RegExpExecArray[] =>
  outsideFences(content)
    .split("\n")
    .map((line) => TASK_LINE.exec(line))
    .filter((task) => task !== null);

/** The state (`"x"` or `" "`) of each numbered checkbox outside code fences, in document order. */
export function checkboxStates(content: string): string[] {
  return taskLines(content).map((task) => task[1] ?? "");
}

// Keeps the label a short resume hint rather than a restatement of the task.
export const MAX_LABEL_LEN = 80;

export function nextTaskLabel(content: string): string | null {
  const open = taskLines(content).find((task) => task[1] !== "x");
  if (open === undefined) return null;
  // Code points, not UTF-16 units, so a label cut mid-emoji keeps its length.
  const chars = Array.from((open[3] ?? "").trim());
  if (chars.length <= MAX_LABEL_LEN) return chars.join("");
  return `${chars.slice(0, MAX_LABEL_LEN - 1).join("").trimEnd()}…`;
}

/** The one completeness rule, by counts: at least one task and every task done. */
export const allTasksDone = ({ done, total }: { done: number; total: number }): boolean => total > 0 && done === total;

/** The same rule read from the plan's text: a plan with no numbered checkboxes is never complete. */
export function planIsComplete(content: string): boolean {
  const states = checkboxStates(content);
  return allTasksDone({ done: states.filter((state) => state === "x").length, total: states.length });
}
