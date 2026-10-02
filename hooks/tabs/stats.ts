import type { RenderElement } from "claude-code";
import { aggregate, type LedgerRecord, METRICS_DIR, parseRecords } from "../../src/core/ledger.ts";
import { PRICING_AS_OF } from "../../src/core/pricing.ts";
import { isSafeSessionId } from "../../src/core/session-id.ts";
import { displayWidth, fitEnd, formatDuration, formatTokens, padEnd, padStart, shortType } from "../../src/core/ui-kit.ts";
import { type Host, reason, type State } from "../host.ts";
import type { Subcommand } from "../omca-router.ts";
import { keyButton, noticeRow, open, type TabView, type View } from "../pane.ts";

type Stats = State["stats"];
type Row = Stats["rows"][number];

const GAP = "  ";
const MIN_NAME = 10;
const RELOAD = "r: Reload";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const finished = (row: Row) => row.outcomes.completed + row.outcomes.aborted + row.outcomes.empty;

async function readRecords(host: Host, dir: string): Promise<{ records: LedgerRecord[]; sessions: number; skipped: number }> {
  if (!(await host.fs.exists(dir))) return { records: [], sessions: 0, skipped: 0 };
  const sessions = (await host.fs.list(dir)).filter((entry) => entry.kind === "dir" && isSafeSessionId(entry.name));
  const perSession = await Promise.all(
    sessions.map(async ({ name }) => {
      const files = (await host.fs.list(`${dir}/${name}`)).filter((entry) => entry.kind === "file" && entry.name.endsWith(".json"));
      return parseRecords(await Promise.all(files.map((file) => host.fs.read(`${dir}/${name}/${file.name}`).catch(() => undefined))));
    }),
  );
  return {
    records: perSession.flatMap((parsed) => parsed.records),
    sessions: perSession.filter((parsed) => parsed.records.length > 0).length,
    skipped: perSession.reduce((sum, parsed) => sum + parsed.skipped, 0),
  };
}

export async function load(host: Host): Promise<void> {
  const [root, readAt] = await Promise.all([host.session.root(), host.clock.now()]);
  const base = { pricingAsOf: PRICING_AS_OF, readAt };
  try {
    const { records, sessions, skipped } = await readRecords(host, `${root}/${METRICS_DIR}`);
    await host.state.stats.set({ ...base, rows: aggregate(records), sessions, skipped, error: null });
  } catch (error) {
    await host.state.stats.set({ ...base, rows: [], sessions: 0, skipped: 0, error: `Could not read ${METRICS_DIR}: ${reason(error)}` });
  }
}

export const command: Subcommand = async (host, e) => {
  await load(host);
  return open(host, e, "stats");
};

// Rounded through the pricing table's integer unit, so $2.855 shows as $2.86 rather than as
// the float just below it.
function money(usd: number): string {
  const cents = Math.round(Math.round(usd * 1e8) / 1e6);
  if (cents === 0 && usd > 0) return "<$0.01";
  return `$${(cents / 100).toFixed(2)}`;
}

type Column = { header: string; width: number; cell: (row: Row, g: View["g"]) => string };

// Drawn in ORDER; a narrow body keeps the columns earliest in KEEP_ORDER and drops the rest whole.
const COLUMNS = {
  runs: { header: "runs", width: 4, cell: (row) => String(row.count) },
  median: { header: "median", width: 6, cell: (row, g) => (finished(row) === 0 ? g.dot : formatDuration(row.medianDurationMs)) },
  tokens: { header: "tokens", width: 6, cell: (row) => formatTokens(row.inputTokens + row.outputTokens) },
  cost: {
    header: "est. cost",
    width: 9,
    cell: (row, g) => {
      if (finished(row) === 0) return g.dot;
      if (row.unpriced === finished(row)) return "n/a";
      return `${money(row.estimatedCostUsd)}${row.unpriced > 0 ? "+" : ""}`;
    },
  },
  evidence: { header: "evidence", width: 8, cell: (row, g) => (finished(row) === 0 ? g.dot : `${Math.round(row.evidenceRate * 100)}%`) },
  outcomes: {
    header: `${padStart("done", 4)}${GAP}${padStart("abort", 5)}${GAP}${padStart("empty", 5)}`,
    width: 18,
    cell: (row) =>
      `${padStart(String(row.outcomes.completed), 4)}${GAP}${padStart(String(row.outcomes.aborted), 5)}${GAP}${padStart(String(row.outcomes.empty), 5)}`,
  },
} as const satisfies Record<string, Column>;

type Name = keyof typeof COLUMNS;
const ORDER: readonly Name[] = ["runs", "median", "tokens", "cost", "evidence", "outcomes"];
const KEEP_ORDER: readonly Name[] = ["runs", "cost", "evidence", "median", "tokens", "outcomes"];

function layout(width: number, names: readonly string[]): { name: number; columns: Column[] } {
  const longest = Math.max(displayWidth("agent"), ...names.map(displayWidth));
  for (let kept = KEEP_ORDER.length; ; kept -= 1) {
    const columns = ORDER.filter((name) => KEEP_ORDER.slice(0, kept).includes(name)).map((name) => COLUMNS[name]);
    const room = width - columns.reduce((sum, column) => sum + GAP.length + column.width, 0);
    if (room >= Math.min(MIN_NAME, longest) || kept === 0) return { name: Math.max(1, Math.min(room, longest)), columns };
  }
}

function summary(stats: Stats, g: View["g"], width: number): string {
  const total = stats.rows.reduce((sum, row) => sum + row.count, 0);
  const live = stats.rows.reduce((sum, row) => sum + row.outcomes.running, 0);
  const line = (skipped: string) =>
    [
      `${plural(total, "delegation")} in ${plural(stats.sessions, "session")}`,
      ...(live > 0 ? [`${live} running`] : []),
      ...(stats.skipped > 0 ? [skipped] : []),
    ].join(` ${g.dot} `);
  const full = line(`${plural(stats.skipped, "unreadable record")} skipped`);
  return displayWidth(full) <= width ? full : line(`${stats.skipped} skipped`);
}

function notes(stats: Stats, g: View["g"]): string | undefined {
  const partial = stats.rows.filter((row) => row.unpriced > 0 && row.unpriced < finished(row));
  const excluded = partial.reduce((sum, row) => sum + row.unpriced, 0);
  const notes = [
    ...(excluded > 0 ? [`+ excludes ${plural(excluded, "unpriced run")}`] : []),
    ...(stats.rows.some((row) => row.unpriced > 0 && row.unpriced === finished(row)) ? ["n/a: no listed price"] : []),
  ];
  return notes.length === 0 ? undefined : notes.join(` ${g.dot} `);
}

export const view: TabView = async (host, view) => {
  const stats = (await host.state.stats.get()).value;
  const words = { loading: "Reading the delegation records", empty: "No delegation statistics have been collected yet." };
  const reload = () => keyButton(view, "r", "Reload", () => load(host));
  if (stats === undefined) return [noticeRow(view, { kind: "loading" }, words)];
  if (stats.error !== null) return [noticeRow(view, { kind: "error", reason: stats.error }, words), reload()];
  const { Box, Text } = view.kit;
  if (stats.rows.length === 0) {
    return [
      noticeRow(view, { kind: "empty" }, words),
      ...(stats.skipped > 0 ? [Text({ dimColor: true, children: [`${plural(stats.skipped, "unreadable record")} skipped`] })] : []),
    ];
  }
  const note = notes(stats, view.g);
  const { name, columns } = layout(view.width, stats.rows.map((row) => shortType(row.agentType)));
  const line = (label: string, cells: readonly string[]) =>
    `${padEnd(fitEnd(label, name, view.g.ellipsis), name)}${columns.map((column, index) => `${GAP}${padStart(cells[index] ?? "", column.width)}`).join("")}`;
  const room = Math.max(1, view.rows - 3 - (note === undefined ? 0 : 1));
  const shown = stats.rows.length > room ? stats.rows.slice(0, room - 1) : stats.rows;
  const rows: RenderElement[] = shown.map((row) =>
    Box({
      key: `stats-${row.agentType}`,
      children: [Text({ children: [line(shortType(row.agentType), columns.map((column) => column.cell(row, view.g)))] })],
    }),
  );
  const more = stats.rows.length - shown.length;
  return [
    Text({ dimColor: true, children: [fitEnd(summary(stats, view.g, view.width), view.width, view.g.ellipsis)] }),
    Text({ dimColor: true, children: [line("agent", columns.map((column) => column.header))] }),
    ...rows,
    ...(more > 0 ? [Text({ dimColor: true, children: [`  ${view.g.down} ${plural(more, "more agent type")}`] })] : []),
    ...(note === undefined ? [] : [Text({ dimColor: true, children: [fitEnd(note, view.width, view.g.ellipsis)] })]),
    Box({
      key: "stats-keys",
      flexDirection: "row",
      children: [
        reload(),
        Text({ dimColor: true, children: [fitEnd(`${GAP}estimated at ${stats.pricingAsOf} list prices`, view.width - RELOAD.length, view.g.ellipsis)] }),
      ],
    }),
  ];
};
