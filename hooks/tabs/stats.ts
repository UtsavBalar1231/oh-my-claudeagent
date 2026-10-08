import type { RenderElement } from "claude-code";
import { RENAMES } from "../../src/core/agent-names.ts";
import { aggregate, type MetricsRecord, METRICS_DIR, parseRecords } from "../../src/core/metrics.ts";
import { formatUsd, PRICING_AS_OF } from "../../src/core/pricing.ts";
import { isSafeId } from "../../src/core/session-id.ts";
import { agentGlyph, COLUMN_GAP, displayWidth, fitEnd, formatDuration, formatTokens, padEnd, padStart, shortType, wrapText } from "../../src/core/ui-kit.ts";
import { agentKey, fitPieces, type Level, levelMark, type Piece, piecesWidth, spark, stack, type ThemeKey, TONE_KEYS } from "../../src/core/visual.ts";
import { type Host, reason, type State, update } from "../host.ts";
import type { Subcommand } from "../omca-router.ts";
import { keyButton, noticeRow, open, type TabView, type View } from "../pane.ts";
import { Card, Line, Row } from "../ui.ts";

type Stats = State["stats"];
type StatsRow = Stats["rows"][number];

const GAP = "  ";
// Columns give way until the longest agent name has this many cells, or all of it.
const NAME_TARGET = 20;
const CARD_FRAME = 4;
// Below this many body rows the Agents card drops its frame, title and column header.
const FRAMED_ROWS = 8;
// The Agents card's top and bottom borders, title and column header.
const AGENTS_FRAME_ROWS = 4;
// The Tokens card's borders, title and strip.
const TOKENS_ROWS = 4;
// The cost card's borders, title and meter.
const COST_ROWS = 4;
// The summary line above the cards and the reload key below them.
const SUMMARY_ROWS = 1;
const RELOAD_ROWS = 1;
// The sparkline never needs more cells than the widest body.
const TURNS_KEPT = 200;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const finished = (row: StatsRow) => row.outcomes.completed + row.outcomes.aborted + row.outcomes.empty;

async function readRecords(host: Host, dir: string): Promise<{ records: MetricsRecord[]; sessions: number; skipped: number }> {
  if (!(await host.fs.exists(dir))) return { records: [], sessions: 0, skipped: 0 };
  const sessions = (await host.fs.list(dir)).filter((entry) => entry.kind === "dir" && isSafeId(entry.name));
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

const ID_PREFIX = "oh-my-claudeagent:";
const CURRENT_NAMES = new Map<string, string>(Object.entries(RENAMES.agents));

function currentName(record: MetricsRecord): MetricsRecord {
  if (!record.agent_type.startsWith(ID_PREFIX)) return record;
  const next = CURRENT_NAMES.get(record.agent_type.slice(ID_PREFIX.length));
  return next === undefined ? record : { ...record, agent_type: `${ID_PREFIX}${next}` };
}

function turnsOf(records: readonly MetricsRecord[]): Stats["turns"] {
  return records
    .filter((record) => record.outcome !== "running")
    .toSorted((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at) || a.agent_id.localeCompare(b.agent_id))
    .slice(-TURNS_KEPT)
    .map((record) => ({ agentType: record.agent_type, tokens: record.input_tokens + record.output_tokens }));
}

// The read time alone never counts as a change, so an unchanged read writes nothing.
const store = (host: Host, next: Stats) =>
  update(host.state.stats, (value) =>
    value !== undefined && JSON.stringify({ ...value, readAt: 0 }) === JSON.stringify({ ...next, readAt: 0 }) ? value : next,
  );

export async function load(host: Host): Promise<void> {
  const [root, readAt] = await Promise.all([host.session.root(), host.clock.now()]);
  const base = { pricingAsOf: PRICING_AS_OF, readAt };
  try {
    const read = await readRecords(host, `${root}/${METRICS_DIR}`);
    const { sessions, skipped } = read;
    const records = read.records.map(currentName);
    await store(host, { ...base, rows: aggregate(records), turns: turnsOf(records), sessions, skipped, error: null });
  } catch (error) {
    await store(host, {
      ...base,
      rows: [],
      turns: [],
      sessions: 0,
      skipped: 0,
      error: `Could not read ${METRICS_DIR}: ${reason(error)}`,
    });
  }
}

export const command: Subcommand = async (host, e) => {
  await load(host);
  return open(host, e, "stats");
};

type Column = { header: string; width: number; cell: (row: StatsRow, view: View, most: number) => Piece[] };

const right = (text: string, width: number, color?: Piece["color"]): Piece[] => [
  { text: padStart(text, width), ...(color === undefined ? {} : { color }) },
];

function evidenceLevel(rate: number): Level {
  if (rate >= 1) return "ok";
  return rate <= 0 ? "fail" : "warn";
}

const BAR = 10;

// Drawn in ORDER; a narrow body keeps the columns earliest in KEEP_ORDER that leave the names their room.
const COLUMNS = {
  bar: {
    header: "",
    width: BAR,
    cell: (row, view, most) =>
      stack(
        [
          { value: row.count, color: agentKey(row.agentType), ascii: "#" },
          { value: most - row.count, color: TONE_KEYS.track, ascii: "." },
        ],
        BAR,
        view.isAscii,
      ),
  },
  runs: { header: "runs", width: 4, cell: (row) => right(String(row.count), 4) },
  median: {
    header: "median",
    width: 6,
    cell: (row, view) => (finished(row) === 0 ? right(view.g.dot, 6, TONE_KEYS.muted) : right(formatDuration(row.medianDurationMs), 6)),
  },
  tokens: { header: "tokens", width: 6, cell: (row) => right(formatTokens(row.inputTokens + row.outputTokens), 6) },
  cost: {
    header: "est. cost",
    width: 9,
    cell: (row, view) => {
      if (finished(row) === 0) return right(view.g.dot, 9, TONE_KEYS.muted);
      if (row.unpriced === finished(row)) return right("n/a", 9, TONE_KEYS.muted);
      return right(`${formatUsd(row.estimatedCostUsd)}${row.unpriced > 0 ? "+" : ""}`, 9);
    },
  },
  evidence: {
    header: "evidence",
    width: 8,
    cell: (row, view) => {
      if (finished(row) === 0) return right(view.g.dot, 8, TONE_KEYS.muted);
      const { glyph, color } = levelMark(evidenceLevel(row.evidenceRate), view.g);
      const rate = ` ${Math.round(row.evidenceRate * 100)}%`;
      return [{ text: padStart(glyph, 8 - displayWidth(rate)), color }, { text: rate }];
    },
  },
} as const satisfies Record<string, Column>;

// Every outcome cell is a glyph, a space, the count padded to the widest count and a space after it.
function outcomesColumn(rows: readonly StatsRow[], g: View["g"]): Column {
  const digits = Math.max(1, ...rows.flatMap(({ outcomes }) => [outcomes.completed, outcomes.aborted, outcomes.empty].map((count) => String(count).length)));
  const marks = [g.check, g.cross, g.warn];
  const width = marks.reduce((sum, glyph) => sum + displayWidth(glyph) + 1 + digits + 1, 0);
  return {
    header: padEnd("outcomes", width),
    width,
    cell: (row) =>
      (
        [
          [g.check, row.outcomes.completed, TONE_KEYS.ok],
          [g.cross, row.outcomes.aborted, TONE_KEYS.fail],
          [g.warn, row.outcomes.empty, TONE_KEYS.warn],
        ] as const
      ).flatMap(([glyph, count, color]) => [
        { text: `${glyph} `, color: count === 0 ? TONE_KEYS.muted : color },
        { text: padEnd(String(count), digits + 1), ...(count === 0 ? { color: TONE_KEYS.muted } : {}) },
      ]),
  };
}

type Name = keyof typeof COLUMNS | "outcomes";
const ORDER: readonly Name[] = ["bar", "runs", "median", "tokens", "cost", "evidence", "outcomes"];
const KEEP_ORDER: readonly Name[] = ["runs", "cost", "evidence", "bar", "median", "tokens", "outcomes"];

// Walks KEEP_ORDER and keeps each column that still leaves the names their room, so a wide column
// that does not fit never hides a narrower one after it.
function layout(width: number, names: readonly string[], lead: number, all: Record<Name, Column>): { name: number; columns: Column[] } {
  const longest = Math.max(displayWidth("agent"), ...names.map(displayWidth));
  const need = Math.min(NAME_TARGET, longest);
  const kept = new Set<Name>();
  let room = width - lead;
  for (const name of KEEP_ORDER) {
    const cost = GAP.length + all[name].width;
    if (room - cost >= need) {
      kept.add(name);
      room -= cost;
    }
  }
  return { name: Math.max(1, Math.min(room, longest)), columns: ORDER.filter((name) => kept.has(name)).map((name) => all[name]) };
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
  return fitEnd(displayWidth(full) <= width ? full : line(`${stats.skipped} skipped`), width, g.ellipsis);
}

function agentsCard(stats: Stats, view: View, width: number, isFramed: boolean): RenderElement {
  const inner = isFramed ? width - CARD_FRAME : width;
  const lead = displayWidth(`${view.g.agent} `);
  const { name, columns } = layout(inner, stats.rows.map((row) => shortType(row.agentType)), lead, { ...COLUMNS, outcomes: outcomesColumn(stats.rows, view.g) });
  const most = Math.max(1, ...stats.rows.map((row) => row.count));
  const cells = (pieces: readonly Piece[][]) => pieces.flatMap((piece) => [{ text: GAP }, ...piece]);
  const head = `${" ".repeat(lead)}${padEnd("agent", name)}${columns.map((column) => `${GAP}${padStart(column.header, column.width)}`).join("")}`;
  const lines = stats.rows.map((row) => {
    const color = agentKey(row.agentType);
    return Row(view.kit, {
      key: `stats-${row.agentType}`,
      pieces: [
        { text: `${agentGlyph(row.agentType, view.g)} `, color },
        { text: padEnd(fitEnd(shortType(row.agentType), name, view.g.ellipsis), name) },
        ...cells(columns.map((column) => column.cell(row, view, most))),
      ],
    });
  });
  if (!isFramed) return view.kit.Box({ key: "stats-agents", flexDirection: "column", children: lines });
  return Card(view.kit, {
    key: "stats-agents",
    title: fitEnd(`Agents ${view.g.dot} ${plural(stats.rows.length, "type")}`, inner, view.g.ellipsis),
    tone: "info",
    isAscii: view.isAscii,
    width,
    children: [view.kit.Text({ dimColor: true, children: [head] }), ...lines],
  });
}

function tokensCard(stats: Stats, view: View, width: number): RenderElement | undefined {
  if (stats.turns.length === 0) return undefined;
  const inner = width - CARD_FRAME;
  const peak = Math.max(...stats.turns.map((turn) => turn.tokens));
  const note = ` peak ${formatTokens(peak)}`;
  const shown = stats.turns.slice(-Math.max(1, inner - displayWidth(note)));
  const strip = [...spark(shown.map((turn) => turn.tokens), view.isAscii)].map((cell, index) => ({
    text: cell,
    color: agentKey(shown[index]?.agentType ?? ""),
  }));
  const isCut = shown.length < stats.turns.length;
  return Card(view.kit, {
    key: "stats-tokens",
    title: fitEnd(`Tokens per turn ${view.g.dot} ${isCut ? `last ${shown.length} of ` : ""}${plural(stats.turns.length, "turn")}`, inner, view.g.ellipsis),
    tone: "info",
    isAscii: view.isAscii,
    width,
    children: [Line(view.kit, fitPieces([...strip, { text: note, color: TONE_KEYS.muted }], inner, view.g.ellipsis))],
  });
}

function costNotes(stats: Stats, g: View["g"]): string {
  const partial = stats.rows.filter((row) => row.unpriced > 0 && row.unpriced < finished(row));
  const excluded = partial.reduce((sum, row) => sum + row.unpriced, 0);
  return [
    ...(excluded > 0 ? [`+ excludes ${plural(excluded, "unpriced run")}`] : []),
    ...(stats.rows.some((row) => row.unpriced > 0 && row.unpriced === finished(row)) ? ["n/a: no listed price"] : []),
    `${stats.pricingAsOf} list prices`,
  ].join(` ${g.dot} `);
}

// Without color, the ASCII meter tells the costliest agents apart by these marks, which its legend repeats.
// Every agent after them shares the "other" mark.
const METER_MARKS = ["#", "=", "+", "*", "%", "&", "~"] as const;
const OTHER_MARK = "o";

type Part = { mark: string; color: ThemeKey; name: string; usd: number };

function partsOf(shares: readonly StatsRow[], view: View): Part[] {
  const own = view.isAscii ? shares.slice(0, METER_MARKS.length) : shares;
  const rest = shares.slice(own.length);
  const parts = own.map((row, index) => ({
    mark: view.isAscii ? (METER_MARKS[index] ?? "#") : agentGlyph(row.agentType, view.g),
    color: agentKey(row.agentType),
    name: shortType(row.agentType),
    usd: row.estimatedCostUsd,
  }));
  if (rest.length === 0) return parts;
  return [...parts, { mark: OTHER_MARK, color: TONE_KEYS.muted, name: "other", usd: rest.reduce((sum, row) => sum + row.estimatedCostUsd, 0) }];
}

// Whole entries, costliest first, at most `maxRows` rows of them; the last row ends in a count of the rest.
function legendOf(parts: readonly Part[], width: number, maxRows: number): Piece[][] {
  const entries = parts.map((part) => [
    { text: `${part.mark} `, color: part.color },
    { text: `${part.name} ${formatUsd(part.usd)}` },
  ]);
  const lines: Piece[][] = [];
  let taken = 0;
  while (taken < entries.length && lines.length < maxRows) {
    const isLast = lines.length === maxRows - 1;
    const line: Piece[] = [];
    for (const entry of entries.slice(taken)) {
      const left = entries.length - taken - 1;
      const more = isLast && left > 0 ? displayWidth(`${GAP}+${left} more`) : 0;
      const next = [...(line.length === 0 ? [] : [{ text: GAP }]), ...entry];
      if ((isLast || line.length > 0) && piecesWidth(line) + piecesWidth(next) + more > width) break;
      line.push(...next);
      taken += 1;
    }
    if (isLast && taken < entries.length) line.push({ text: `${line.length === 0 ? "" : GAP}+${entries.length - taken} more`, color: TONE_KEYS.muted });
    lines.push(line);
  }
  return lines;
}

// `room` is every row the card may take; what its other lines leave goes to the legend.
function costCard(stats: Stats, view: View, width: number, room: number): RenderElement {
  const { Text } = view.kit;
  const inner = width - CARD_FRAME;
  const priced = stats.rows.filter((row) => finished(row) > row.unpriced);
  const title = fitEnd("Estimated cost", inner, view.g.ellipsis);
  if (priced.length === 0) {
    return Card(view.kit, {
      key: "stats-cost",
      title,
      tone: "warn",
      isAscii: view.isAscii,
      width,
      children: [Text({ dimColor: true, wrap: "wrap", children: ["No finished run has a listed price, so no cost is shown"] })],
    });
  }
  const total = priced.reduce((sum, row) => sum + row.estimatedCostUsd, 0);
  const money = `${formatUsd(total)}${stats.rows.some((row) => row.unpriced > 0) ? "+" : ""}`;
  const shares = priced.filter((row) => row.estimatedCostUsd > 0).toSorted((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
  const parts = partsOf(shares, view);
  const meter = stack(
    parts.length === 0
      ? [{ value: 1, color: TONE_KEYS.track, ascii: "." }]
      : parts.map((part) => ({ value: part.usd, color: part.color, ascii: part.mark })),
    Math.max(0, inner - displayWidth(money) - 1),
    view.isAscii,
  );
  const notes = costNotes(stats, view.g);
  const legend = legendOf(parts, inner, Math.max(1, room - COST_ROWS - wrapText(notes, inner).length));
  return Card(view.kit, {
    key: "stats-cost",
    title,
    tone: "ok",
    isAscii: view.isAscii,
    width,
    children: [
      Line(view.kit, fitPieces([{ text: money, bold: true }, { text: " " }, ...meter], inner, view.g.ellipsis)),
      ...legend.map((pieces) => Line(view.kit, fitPieces(pieces, inner, view.g.ellipsis))),
      Text({ dimColor: true, wrap: "wrap", children: [notes] }),
    ],
  });
}

function sideBySide(view: View, key: string, cards: readonly RenderElement[]): RenderElement {
  return view.kit.Box({ key, flexDirection: "row", columnGap: COLUMN_GAP, width: view.width, children: cards });
}

export const view: TabView = async (host, view) => {
  const stats = (await host.state.stats.get()).value;
  const words = { loading: "Reading the delegation records", empty: "No delegation statistics have been collected yet." };
  const reload = () => keyButton(view, "r", "Reload", () => load(host));
  if (stats === undefined) return [noticeRow(view, { kind: "loading" }, words)];
  if (stats.error !== null) return [noticeRow(view, { kind: "error", reason: stats.error }, words), reload()];
  const { Text } = view.kit;
  if (stats.rows.length === 0) {
    return [
      noticeRow(view, { kind: "empty" }, words),
      ...(stats.skipped > 0 ? [Text({ dimColor: true, children: [`${plural(stats.skipped, "unreadable record")} skipped`] })] : []),
      reload(),
    ];
  }
  const isFramed = view.rows >= FRAMED_ROWS;
  const half = Math.floor((view.width - COLUMN_GAP) / 2);
  const tokens = tokensCard(stats, view, view.tier === "split" ? half : view.width);
  const isPair = view.tier === "split" && tokens !== undefined;
  const above = SUMMARY_ROWS + stats.rows.length + (isFramed ? AGENTS_FRAME_ROWS : 0) + RELOAD_ROWS + (tokens === undefined || isPair ? 0 : TOKENS_ROWS);
  const cost = costCard(stats, view, isPair ? view.width - COLUMN_GAP - half : view.width, view.rows - above);
  const lower = isPair ? [sideBySide(view, "stats-lower", [tokens, cost])] : [...(tokens === undefined ? [] : [tokens]), cost];
  return [
    Text({ dimColor: true, children: [summary(stats, view.g, view.width)] }),
    agentsCard(stats, view, view.width, isFramed),
    ...lower,
    reload(),
  ];
};
