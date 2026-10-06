export const FENCE = /^\s*(```|~~~)/;
const TAB = 9;
const NEWLINE = 10;
const CR = 13;

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
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (!isUnsafe(code)) continue;
    out += text.slice(start, index);
    if (code === CR) {
      out += "\n";
      if (text.charCodeAt(index + 1) === NEWLINE) index += 1;
    }
    start = index + 1;
  }
  return start === 0 ? text : out + text.slice(start);
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

// Keeps the label a short resume hint rather than a restatement of the task.
export const MAX_LABEL_LEN = 80;

// Code points, not UTF-16 units, so a label cut mid-emoji keeps its length.
function capLabel(text: string): string {
  const chars = Array.from(text.trim());
  if (chars.length <= MAX_LABEL_LEN) return chars.join("");
  return `${chars.slice(0, MAX_LABEL_LEN - 1).join("").trimEnd()}…`;
}

export type PlanTask = { number: number; label: string; checked: boolean; line: number };

/** The numbered tasks outside code fences in document order; `line` indexes the cleaned text. */
export function planTasks(content: string): PlanTask[] {
  return outsideFences(content).split("\n").flatMap((text, line) => {
    const task = TASK_LINE.exec(text);
    return task === null ? [] : [{ number: Number(task[2]), label: capLabel(task[3] ?? ""), checked: task[1] === "x", line }];
  });
}

/** The state (`"x"` or `" "`) of each numbered checkbox outside code fences, in document order. */
export const checkboxStates = (content: string): string[] => planTasks(content).map((task) => (task.checked ? "x" : " "));

export const nextTaskLabel = (content: string): string | null => planTasks(content).find((task) => !task.checked)?.label ?? null;

/** The one completeness rule, by counts: at least one task and every task done. */
export const allTasksDone = ({ done, total }: { done: number; total: number }): boolean => total > 0 && done === total;

/** The same rule read from the plan's text: a plan with no numbered checkboxes is never complete. */
export function planIsComplete(content: string): boolean {
  const tasks = planTasks(content);
  return allTasksDone({ done: tasks.filter((task) => task.checked).length, total: tasks.length });
}
