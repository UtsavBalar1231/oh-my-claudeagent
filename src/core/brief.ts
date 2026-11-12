export type BriefField = { label: string; num: string; body: string };

const BRACKET = /^\[([A-Z][A-Z ]{0,22}[A-Z])\]:[ \t]*(.*)$/;
const NUMBERED = /^(\d{1,2})\.[ \t]+([A-Z][A-Z ]{0,22}[A-Z]):[ \t]*(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

type Fence = { char: string; length: number };

function labelOf(line: string): { label: string; num: string; rest: string } | undefined {
  const bracket = BRACKET.exec(line);
  if (bracket?.[1] !== undefined) return { label: bracket[1], num: "", rest: bracket[2] ?? "" };
  const numbered = NUMBERED.exec(line);
  if (numbered?.[1] !== undefined && numbered[2] !== undefined) return { label: numbered[2], num: numbered[1], rest: numbered[3] ?? "" };
  return undefined;
}

function fenceAfter(open: Fence | undefined, line: string): Fence | undefined {
  const match = FENCE.exec(line);
  const run = match?.[1];
  if (run === undefined) return open;
  const char = run.charAt(0);
  if (open === undefined) return { char, length: run.length };
  const isClose = char === open.char && run.length >= open.length && (match?.[2] ?? "").trim() === "";
  return isClose ? undefined : open;
}

const bodyOf = (lines: readonly string[]): string => lines.join("\n").replace(/^(?:[ \t]*\n)+/, "").trimEnd();

/** The fields of an OMCA brief: `[LABEL]: body` or `1. LABEL: body` at column 0, outside a code fence. */
export function briefFields(text: string): BriefField[] {
  const fields: BriefField[] = [];
  let current: { label: string; num: string; lines: string[] } = { label: "", num: "", lines: [] };
  let fence: Fence | undefined;
  let isLabeled = false;
  const close = () => {
    const body = bodyOf(current.lines);
    if (current.label !== "" || body !== "") fields.push({ label: current.label, num: current.num, body });
  };
  for (const line of text.split("\n")) {
    const head = fence === undefined ? labelOf(line) : undefined;
    if (head !== undefined) {
      close();
      isLabeled = true;
      current = { label: head.label, num: head.num, lines: [head.rest] };
      continue;
    }
    fence = fenceAfter(fence, line);
    current.lines.push(line);
  }
  close();
  return isLabeled ? fields : [{ label: "", num: "", body: bodyOf(text.split("\n")) }];
}

const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** `1,102 chars · 15 lines`, with `dot` the glyph set's separator. */
export function briefSize(text: string, dot: string): string {
  const chars = text.length;
  const lines = text.split("\n").length;
  return `${grouped(chars)} ${chars === 1 ? "char" : "chars"} ${dot} ${grouped(lines)} ${lines === 1 ? "line" : "lines"}`;
}
