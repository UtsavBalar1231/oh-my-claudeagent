import type { RenderElement } from "claude-code";
import { EVIDENCE_TYPES } from "../../src/core/evidence.ts";
import { LEDGER } from "../../src/core/omca-paths.ts";
import { COLORS, fitEnd, formatWhen, levelMark, padEnd, padStart } from "../../src/core/ui-kit.ts";
import { type Host, reason, type State } from "../host.ts";
import { noticeRow, type TabView } from "../pane.ts";

type Entry = State["pane"]["evidence"][number];

const NEWEST = 20;
const TYPE = 6;
const EXIT = 4;
const WHEN = 11;
const GAP = "  ";
const TYPE_LABEL: Readonly<Record<Entry["type"], string>> = {
  build: "build",
  test: "test",
  lint: "lint",
  manual: "manual",
  final_verification: "final",
};

let signature: string | undefined;

export const reset = (): void => {
  signature = undefined;
};

const isType = (value: unknown): value is Entry["type"] => EVIDENCE_TYPES.some((type) => type === value);

function parseLedger(text: string): Entry[] {
  const data: unknown = JSON.parse(text);
  const entries = typeof data === "object" && data !== null && "entries" in data ? data.entries : undefined;
  if (!Array.isArray(entries)) throw new Error("it holds no entries list");
  return entries
    .flatMap((raw: unknown): Entry[] => {
      if (typeof raw !== "object" || raw === null) return [];
      const entry = raw as Record<string, unknown>;
      const { type, command, exit_code: exitCode, timestamp, output_snippet: snippet, verified_by: verifiedBy } = entry;
      const at = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
      if (!isType(type) || typeof command !== "string" || typeof exitCode !== "number" || Number.isNaN(at)) return [];
      return [
        {
          type,
          command,
          exitCode,
          at,
          snippet: typeof snippet === "string" ? snippet : "",
          verifiedBy: typeof verifiedBy === "string" && verifiedBy !== "" ? verifiedBy : null,
        },
      ];
    })
    .slice(-NEWEST)
    .reverse();
}

// Unchanged files answer undefined, so a refresh writes, and redraws, nothing.
export async function read(host: Host, root: string): Promise<{ entries: Entry[]; error: string | null } | undefined> {
  const path = `${root}/${LEDGER}`;
  let seen = "missing";
  try {
    if (await host.fs.exists(path)) {
      const { mtimeMs, size } = await host.fs.stat(path);
      seen = `${mtimeMs}:${size}`;
    }
    if (seen === signature) return undefined;
    const entries = seen === "missing" ? [] : parseLedger(await host.fs.read(path));
    signature = seen;
    return { entries, error: null };
  } catch (error) {
    const failure = `Could not read ${LEDGER}: ${reason(error)}`;
    if (signature === failure) return undefined;
    signature = failure;
    return { entries: [], error: failure };
  }
}

export const view: TabView = async (host, view) => {
  const pane = (await host.state.pane.get()).value;
  const words = { loading: "Reading the evidence ledger", empty: "No verification evidence has been logged here yet." };
  if (pane === undefined) return [noticeRow(view, { kind: "loading" }, words)];
  if (pane.errors.evidence !== null) return [noticeRow(view, { kind: "error", reason: pane.errors.evidence }, words)];
  if (pane.evidence.length === 0) return [noticeRow(view, { kind: "empty" }, words)];
  const { Box, Text } = view.kit;
  const commandWidth = Math.max(1, view.width - 2 - TYPE - EXIT - WHEN - GAP.length * 3);
  const row = (entry: Entry, index: number): RenderElement => {
    const { glyph, color } = levelMark(entry.exitCode === 0 ? "ok" : "fail", view.g);
    const exit = padStart(String(entry.exitCode), EXIT);
    return Box({
      key: `evidence-${index}`,
      flexDirection: "row",
      children: [
        Text({ color, children: [`${glyph} `] }),
        Text({ children: [`${padEnd(TYPE_LABEL[entry.type], TYPE)}${GAP}${padEnd(fitEnd(entry.command, commandWidth, view.g.ellipsis), commandWidth)}${GAP}`] }),
        Text(entry.exitCode === 0 ? { dimColor: true, children: [exit] } : { color: COLORS.fail, children: [exit] }),
        Text({ dimColor: true, children: [`${GAP}${formatWhen(entry.at)}`] }),
      ],
    });
  };
  const summary = `${pane.evidence.length} most recent ${pane.evidence.length === 1 ? "entry" : "entries"}, newest first`;
  return [
    Text({ dimColor: true, children: [fitEnd(summary, view.width, view.g.ellipsis)] }),
    Text({
      dimColor: true,
      children: [`  ${padEnd("type", TYPE)}${GAP}${padEnd("command", commandWidth)}${GAP}${padStart("exit", EXIT)}${GAP}${padEnd("when", WHEN)}`],
    }),
    ...pane.evidence.map(row),
  ];
};
