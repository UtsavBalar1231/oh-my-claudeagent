/** @jsxImportSource @opentui/solid */

import { usePlugin } from "@opencode/plugin/tui";
import type { PanelInput } from "@opencode/plugin/tui/context";
import { MouseButton, TextAttributes, type MouseEvent, type RGBA, type ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions, type JSX } from "@opentui/solid";
import { For, Show, createEffect, createMemo, createSignal, on, type Accessor } from "solid-js";
import { createStore } from "solid-js/store";
import { parseEntries } from "../src/core/notepad.ts";
import { groupTasks, openBlockers, runState, type NativeTask } from "../src/core/native-tasks.ts";
import { clockOf, dayOf, displayWidth, formatWhen, oneLine, wrapText, type Glyphs } from "../src/core/ui-kit.ts";
import type { Snapshot } from "./rpc.ts";
import { agentLabel, agentRows, canToggleFullscreen, capList, chipLabels, clampCursor, continuationLine, fitHints, fitParts, money, noRunnableNote, plain, progress, tabs, taskCounts, verdictText, type Hint, type ReadState, type Tab } from "./tui-model.ts";

type Check = Snapshot["evidence"]["entries"][number];
type Props = {
  panel: PanelInput;
  glyphs: Glyphs;
  current: Accessor<ReadState<Snapshot> | undefined>;
  tab: Accessor<Tab>;
  select: (tab: Tab) => void;
  refresh: () => void;
  toggleFullscreen: () => void;
};
type Item = { text: string; open: () => void; marker?: string; markerColor?: RGBA; meta?: readonly string[]; muted?: boolean; current?: boolean };
type Section = { title: string; detail?: string; items: Item[] };
type Choice = { title: string; category: string; footer?: string; open: () => void };

const listTabs = ["Tasks", "Agents", "Evidence", "Notepad"] as const satisfies readonly Tab[];
const RECENT_CHECKS = 3;
const MIN_TITLE = 16;
const stamp = (at: number) => `${dayOf(at)} ${clockOf(at)}`;
const checkType = (type: string) => type === "final_verification" ? "Final check" : type[0]?.toUpperCase() + type.slice(1);
const capitalize = (text: string) => text[0]?.toUpperCase() + text.slice(1);
const flat = (text: string) => oneLine(plain(text));

export function OmcaPanel(props: Props): JSX.Element {
  const ctx = usePlugin();
  const theme = () => ctx.theme;
  const g = props.glyphs;
  const dimensions = useTerminalDimensions();
  const value = () => props.current()?.value;
  const focused = () => props.panel.focused;
  const docked = () => props.panel.presentation === "panel";
  // Row text sits 2 cells in from either edge, as the header does.
  const room = () => Math.max(MIN_TITLE, props.panel.width - 4);
  const [cursors, setCursors] = createStore<Record<Tab, number>>({ Tasks: 0, Agents: 0, Evidence: 0, Notepad: 0, Doctor: 0 });
  const [rows, setRows] = createSignal(dimensions().height);
  let scroll: ScrollBoxRenderable | undefined;
  let armed = false;

  function showDetail(title: string, paragraphs: readonly string[]) {
    ctx.ui.dialog.show(() => <Detail title={title} paragraphs={paragraphs} />);
    ctx.ui.dialog.set({ size: "large" });
  }

  function Detail(detail: { title: string; paragraphs: readonly string[] }): JSX.Element {
    const surface = ctx.theme.surface("dialog");
    const size = useTerminalDimensions();
    return <box paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
      <box flexDirection="row" gap={2}>
        <text fg={surface.text.base} attributes={TextAttributes.BOLD} flexGrow={1} minWidth={0} wrapMode="none" truncate>{plain(detail.title)}</text>
        <text fg={surface.text.muted} flexShrink={0} onMouseUp={() => ctx.ui.dialog.clear()}>esc</text>
      </box>
      <scrollbox focused maxHeight={Math.max(3, Math.floor(size().height * 3 / 4) - 5)} horizontalScrollbarOptions={{ visible: false }}>
        <box gap={1}>
          <For each={detail.paragraphs}>{(paragraph, index) => <text fg={index() === 0 ? surface.text.base : surface.text.muted} wrapMode="word">{plain(paragraph)}</text>}</For>
        </box>
      </scrollbox>
    </box>;
  }

  async function choose(title: string, choices: readonly Choice[]) {
    const index = await ctx.ui.dialog.select({
      title,
      options: choices.map((choice, value) => ({ title: plain(choice.title), value, category: choice.category, ...(choice.footer ? { footer: choice.footer } : {}) })),
    });
    if (index !== undefined) choices[index]?.open();
  }

  function capped<T>(all: readonly T[], item: (entry: T) => Item, title: string, choice: (entry: T) => Choice): Item[] {
    const { shown, more } = capList(all);
    const items = shown.map(item);
    if (more > 0) items.push({ text: `${more} more`, muted: true, marker: g.ellipsis, open: () => void choose(title, all.map(choice)) });
    return items;
  }

  function openTask(task: NativeTask, tasks: readonly NativeTask[]) {
    const waiting = openBlockers(task, tasks);
    showDetail(`Task #${task.id}`, [
      flat(task.subject),
      `Status: ${task.blockedReason !== "" ? "closed as blocked" : task.status.replace("_", " ")}${task.isFinal ? " · final task" : ""}`,
      task.description,
      task.blockedReason && `Closed as blocked: ${task.blockedReason}`,
      waiting.length > 0 ? `Waiting on ${waiting.map((id) => `#${id}`).join(", ")}` : "",
      ...task.details.map((detail) => `${detail.name}: ${detail.text}`),
    ].filter(Boolean));
  }

  function openCheck(entry: Check) {
    showDetail(`${checkType(entry.type)} · exit ${entry.exitCode}`, [
      entry.command,
      stamp(entry.at),
      entry.snippet || "No output recorded.",
      `Reported by: ${entry.verifiedBy ?? "unspecified"}`,
      `Task: ${entry.taskId ? `#${entry.taskId}` : "unscoped"}`,
      "This is an attested result, not verification of the current checkout.",
    ]);
  }

  const checkItem = (entry: Check): Item => ({
    text: flat(entry.command),
    marker: entry.exitCode === 0 ? g.check : g.cross,
    markerColor: entry.exitCode === 0 ? theme().text.feedback.success.base : theme().text.feedback.error.base,
    meta: [`exit ${entry.exitCode}`, formatWhen(entry.at), checkType(entry.type)],
    open: () => openCheck(entry),
  });
  const checkChoice = (entry: Check): Choice => ({ title: flat(entry.command), category: checkType(entry.type), footer: `exit ${entry.exitCode} · ${formatWhen(entry.at)}`, open: () => openCheck(entry) });
  const checks = () => value()?.evidence.entries.toReversed() ?? [];
  const errors = () => value()?.health.filter((item) => item.state === "error") ?? [];

  const tasksView = createMemo(() => {
    const run = value()?.run;
    if (!run) return undefined;
    const groups = groupTasks(run.tasks);
    const marker = (name: string): [string, RGBA] => {
      switch (name) {
        case "Running": return [g.running, theme().text.action.primary.base];
        case "Waiting": return [g.waiting, theme().text.muted];
        case "Blocked": return [g.blocked, theme().text.feedback.warning.base];
        case "Done": return [g.check, theme().text.feedback.success.base];
        default: return [g.pending, theme().text.muted];
      }
    };
    const taskItem = (name: string) => (task: NativeTask): Item => {
      const [glyph, color] = marker(name);
      const waiting = openBlockers(task, run.tasks);
      return {
        text: flat(`#${task.id} ${task.subject}`),
        marker: glyph,
        markerColor: color,
        muted: name === "Done",
        meta: [task.isFinal ? "final" : "", name === "Blocked" ? flat(task.blockedReason) : "", name === "Waiting" ? `after ${waiting.map((id) => `#${id}`).join(", ")}` : ""],
        open: () => openTask(task, run.tasks),
      };
    };
    const choice = (name: string) => (task: NativeTask): Choice => ({ title: flat(`#${task.id} ${task.subject}`), category: name, ...(task.isFinal ? { footer: "final" } : {}), open: () => openTask(task, run.tasks) });
    const sections: Section[] = groups.map((group) => {
      if (group.name === "Done" && groups.length > 1) {
        const [glyph, color] = marker("Done");
        return { title: "", items: [{ text: `${group.tasks.length} done`, marker: glyph, markerColor: color, muted: true, open: () => void choose("Done tasks", group.tasks.map(choice("Done"))) }] };
      }
      return { title: group.name, detail: String(group.tasks.length), items: capped(group.tasks, taskItem(group.name), `${group.name} tasks`, choice(group.name)) };
    });
    const all = checks();
    if (all.length > 0) sections.push({ title: "Recent checks", detail: all.length > RECENT_CHECKS ? `${RECENT_CHECKS} of ${all.length}` : String(all.length), items: all.slice(0, RECENT_CHECKS).map(checkItem) });
    const items = sections.flatMap((section) => section.items);
    const continuation = continuationLine(value()?.continuation ?? { state: "off", reason: "" }, run.tasks);
    const next = runState(run.tasks)?.next;
    // Progress, continuation, the Next callout, the sections, the health errors and the bottom padding.
    const lines = 1 + (continuation ? wrapText(continuation.text, room()).length : 0) + (next ? 1 : wrapText(noRunnableNote(run.tasks), room() - 1).length)
      + sections.reduce((sum, section) => sum + (section.title ? 1 : 0) + section.items.length, 0)
      + errors().reduce((sum, item) => sum + wrapText(`${item.name}: ${item.detail}`, room()).length, 0) + 1;
    return { run, sections, items, lines, gaps: 1 + sections.length + (errors().length > 0 ? 1 : 0) };
  });

  const family = createMemo(() => {
    const members = new Set(ctx.data.session.family(props.panel.sessionID));
    return agentRows(ctx.data.session.list().filter((session) => members.has(session.id)), (id) => ctx.data.session.status(id) === "running", (id) => ctx.data.session.cost(id));
  });
  const agentsView = createMemo((): Section => {
    const { rows: members, total } = family();
    const working = members.filter((row) => row.running).length;
    const navigate = (sessionID: string) => () => ctx.ui.router.navigate({ type: "session", sessionID });
    const item = (row: typeof members[number]): Item => ({
      text: flat(`${agentLabel(row.session.agent)}: ${row.session.title ?? row.session.id}`),
      marker: row.running ? g.running : g.pending,
      markerColor: row.running ? theme().text.action.primary.base : theme().text.muted,
      meta: [row.running ? "Running" : "Idle", row.cost > 0 ? money(row.cost) : ""],
      current: row.session.id === props.panel.sessionID,
      open: navigate(row.session.id),
    });
    const choice = (row: typeof members[number]): Choice => ({ title: flat(`${agentLabel(row.session.agent)}: ${row.session.title ?? row.session.id}`), category: row.running ? "Running" : "Idle", ...(row.cost > 0 ? { footer: money(row.cost) } : {}), open: navigate(row.session.id) });
    return { title: "Sessions", detail: `· ${[`${working} working`, total > 0 ? money(total) : ""].filter(Boolean).join(" · ")}`, items: capped(members, item, "OMCA sessions", choice) };
  });

  const evidenceItems = createMemo(() => capped(checks(), checkItem, "Recorded checks", checkChoice));

  const notepadView = createMemo((): Section[] => (value()?.notepads ?? []).map((note) => {
    const entries = parseEntries(note.content).toReversed();
    const title = capitalize(note.section);
    const open = (entry: typeof entries[number]) => () => showDetail(entry.at === null ? title : `${title} · ${formatWhen(entry.at)}`, [entry.text]);
    return {
      title,
      detail: String(entries.length),
      items: capped(entries, (entry) => ({ text: flat(entry.text), marker: g.dot, markerColor: theme().text.muted, meta: entry.at === null ? [] : [formatWhen(entry.at)], open: open(entry) }), `${title} notes`, (entry) => ({ title: flat(entry.text), category: title, ...(entry.at === null ? {} : { footer: formatWhen(entry.at) }), open: open(entry) })),
    };
  }));

  const items = (tab: Tab): Item[] => {
    switch (tab) {
      case "Tasks": return tasksView()?.items ?? [];
      case "Agents": return agentsView().items;
      case "Evidence": return evidenceItems();
      case "Notepad": return notepadView().flatMap((section) => section.items);
      case "Doctor": return [];
    }
  };
  const cursor = (tab: Tab) => clampCursor(cursors[tab], items(tab).length);
  const rowId = (tab: Tab, index: number) => `omca-${tab.toLowerCase()}-${index}`;
  function move(tab: Tab, by: number) {
    const length = items(tab).length;
    if (length === 0) return;
    const next = clampCursor(cursor(tab) + by, length);
    setCursors(tab, next);
    scroll?.scrollChildIntoView(rowId(tab, next));
  }
  // The tabs share one scrollbox, so a tab opens at its top with its cursor in view.
  createEffect(on(props.tab, (tab) => {
    scroll?.scrollTo(0);
    if (items(tab).length > 0) scroll?.scrollChildIntoView(rowId(tab, cursor(tab)));
  }, { defer: true }));
  const fullscreenAvailable = () => canToggleFullscreen(props.panel.presentation, props.panel.width);
  const compact = () => {
    const view = tasksView();
    return props.tab() === "Tasks" && view !== undefined && view.lines + view.gaps > rows();
  };

  ctx.keymap.layer(() => ({
    commands: [
      ...tabs.map((tab, index) => ({ id: `omca.tab.${tab.toLowerCase()}`, title: `OMCA ${tab}`, group: "OMCA", bind: String(index + 1), run: () => props.select(tab) })),
      { id: "omca.refresh", title: "Refresh OMCA", group: "OMCA", bind: "r", run: props.refresh },
      { id: "omca.fullscreen", title: "Toggle OMCA fullscreen", group: "OMCA", bind: "f", enabled: fullscreenAvailable, run: props.toggleFullscreen },
      { id: "omca.close", title: "Close OMCA", group: "OMCA", bind: "escape", run: props.panel.close },
    ],
  }));
  for (const tab of listTabs) {
    const id = tab.toLowerCase();
    ctx.keymap.layer(() => ({
      enabled: props.tab() === tab,
      commands: [
        { id: `omca.${id}.up`, title: "Previous row", group: "OMCA", bind: "up,k", run: () => move(tab, -1) },
        { id: `omca.${id}.down`, title: "Next row", group: "OMCA", bind: "down,j", run: () => move(tab, 1) },
        { id: `omca.${id}.open`, title: "Open row", group: "OMCA", bind: "return", run: () => items(tab)[cursor(tab)]?.open() },
      ],
    }));
  }

  const key = (id: string) => ctx.keymap.shortcuts(id)[0] ?? "";
  const hints = createMemo((): { left: Hint | undefined; right: Hint[] } => {
    const tab = props.tab();
    const id = tab.toLowerCase();
    const left = docked() ? { key: key("pane.focus.left"), label: "focus prompt" } : { key: key("omca.close"), label: "close" };
    const listed = tab !== "Doctor" && items(tab).length > 0;
    const right: Hint[] = [
      ...(listed ? [{ key: key(`omca.${id}.open`), label: "open" }, { key: `${key(`omca.${id}.up`)}${key(`omca.${id}.down`)}`, label: "move" }] : []),
      ...(tab === "Doctor" ? [{ key: "↑↓", label: "scroll" }] : []),
      { key: key("omca.refresh"), label: "refresh" },
      ...(fullscreenAvailable() ? [{ key: key("omca.fullscreen"), label: docked() ? "fullscreen" : "dock" }] : []),
      ...(docked() ? [{ key: key("omca.close"), label: "close" }] : []),
      { key: `${key("omca.tab.tasks")}-${key("omca.tab.doctor")}`, label: "tabs" },
    ];
    const leftHint = left.key ? left : undefined;
    const leftWidth = leftHint ? displayWidth(`${leftHint.key} ${leftHint.label}`) + 2 : 0;
    return { left: leftHint, right: fitHints(right, props.panel.width - 4 - leftWidth) };
  });

  function HintText(hint: { hints: readonly Hint[] }): JSX.Element {
    return <For each={hint.hints}>{(item, index) => <>
      <span style={focused() ? { fg: theme().background.action.primary.focused } : {}}>{`${index() === 0 ? "" : "  "}${item.key}`}</span>
      <span style={focused() ? { fg: theme().text.muted } : {}}>{` ${item.label}`}</span>
    </>}</For>;
  }

  function act(event: MouseEvent, run: () => void) {
    const pressedHere = armed;
    armed = false;
    if (event.button !== MouseButton.LEFT || !pressedHere) return;
    event.stopPropagation();
    run();
  }

  function Row(row: { tab: Tab; item: Item; index: number }): JSX.Element {
    const active = () => focused() && cursor(row.tab) === row.index;
    const meta = () => {
      const width = displayWidth(`${row.item.marker ? `${row.item.marker} ` : ""}${row.item.text}`);
      return fitParts(row.item.meta ?? [], room() - Math.min(width, Math.max(MIN_TITLE, Math.ceil(room() / 2))) - 2);
    };
    const fg = () => active() ? theme().text.action.primary.focused : row.item.current ? theme().text.action.primary.selected : row.item.muted ? theme().text.muted : theme().text.base;
    return <box
      id={rowId(row.tab, row.index)}
      flexDirection="row"
      gap={2}
      paddingX={1}
      flexShrink={0}
      backgroundColor={active() ? theme().background.action.primary.focused : row.item.current ? theme().background.action.primary.selected : "transparent"}
      onMouseMove={() => setCursors(row.tab, row.index)}
      onMouseUp={(event: MouseEvent) => act(event, () => {
        setCursors(row.tab, row.index);
        row.item.open();
      })}
    >
      <text fg={fg()} attributes={active() ? TextAttributes.BOLD : 0} flexGrow={1} minWidth={0} wrapMode="none" truncate>
        <Show when={row.item.marker}><span style={{ fg: active() ? fg() : row.item.markerColor ?? fg() }}>{`${row.item.marker} `}</span></Show>
        {row.item.text}
      </text>
      <Show when={meta()}><text fg={active() ? fg() : theme().text.muted} flexShrink={0} wrapMode="none">{meta()}</text></Show>
    </box>;
  }

  function Line(line: { children: JSX.Element; fg?: RGBA }): JSX.Element {
    return <box paddingX={1} flexShrink={0}>
      <text fg={line.fg ?? theme().text.muted} wrapMode="none" truncate>{line.children}</text>
    </box>;
  }

  /** Text wrapped at spaces only, so a name or command is never split. */
  function Prose(prose: { text: string; fg?: RGBA; indent?: number }): JSX.Element {
    return <box paddingLeft={1 + (prose.indent ?? 0)} paddingRight={1} flexShrink={0}>
      <For each={wrapText(flat(prose.text), room() - (prose.indent ?? 0))}>{(line) => <text fg={prose.fg ?? theme().text.muted} wrapMode="none" truncate>{line}</text>}</For>
    </box>;
  }

  function Gap(gap: { always?: boolean }): JSX.Element {
    return <Show when={gap.always || !compact()}><box height={1} flexShrink={0} /></Show>;
  }

  function Sections(view: { tab: Tab; sections: readonly Section[] }): JSX.Element {
    const starts = () => view.sections.map((_section, index) => view.sections.slice(0, index).reduce((sum, section) => sum + section.items.length, 0));
    return <For each={view.sections}>{(section, index) => <>
      <Show when={index() > 0}><Gap /></Show>
      <Show when={section.title}>
        <Line fg={theme().text.base}><strong>{section.title}</strong><Show when={section.detail}><span style={{ fg: theme().text.muted }}>{` ${section.detail}`}</span></Show></Line>
      </Show>
      <For each={section.items}>{(item, row) => <Row tab={view.tab} item={item} index={(starts()[index()] ?? 0) + row()} />}</For>
    </>}</For>;
  }

  function Empty(empty: { title: string; message: string }): JSX.Element {
    return <>
      <Line fg={theme().text.base}><strong>{empty.title}</strong></Line>
      <Prose text={empty.message} />
    </>;
  }

  const loading = () => !props.current() || props.current()?.phase === "loading";
  const detail = () => value()?.run?.name ?? (loading() || props.current()?.phase === "error" ? "" : "no run");
  const status = () => {
    const current = props.current();
    const word = current?.phase === "error" ? "offline" : current?.updating ? "updating" : "";
    const run = value()?.run;
    const count = run ? `${taskCounts(run.tasks).done}/${run.tasks.length}` : "";
    return [word, count].filter(Boolean).join(" · ");
  };
  const errorText = () => {
    const current = props.current();
    if (current?.phase !== "error") return "";
    const reason = (current.error ?? "Snapshot unavailable").replace(/\.$/, "");
    return `Could not refresh: ${reason}.${value() ? " Showing the last snapshot." : ""}${focused() ? " Press r to retry." : ""}`;
  };

  return <box flexDirection="column" flexGrow={1} minWidth={0} onMouseDown={() => (armed = props.panel.focused)}>
    <box flexDirection="row" gap={1} paddingLeft={2} paddingRight={2} paddingTop={docked() ? 1 : 0} flexShrink={0}>
      <box flexDirection="row" flexGrow={1} minWidth={0}>
        <text fg={theme().text.action.secondary.base} attributes={TextAttributes.BOLD} flexShrink={0} wrapMode="none">OMCA</text>
        <Show when={detail()}><text fg={theme().text.muted} flexGrow={1} minWidth={0} wrapMode="none" truncate>{` · ${flat(detail())}`}</text></Show>
      </box>
      <Show when={status()}><text fg={theme().text.muted} flexShrink={0} wrapMode="none">{status()}</text></Show>
    </box>
    <box flexDirection="row" gap={2} paddingLeft={2} paddingRight={2} paddingTop={1} flexShrink={0}>
      <For each={chipLabels(props.tab(), props.panel.width - 4)}>{(chip) => <text
        fg={props.tab() === chip.tab ? theme().text.action.primary.base : theme().text.muted}
        attributes={props.tab() === chip.tab ? TextAttributes.BOLD : 0}
        flexShrink={0}
        wrapMode="none"
        onMouseUp={(event: MouseEvent) => act(event, () => props.select(chip.tab))}
      >{chip.label}</text>}</For>
    </box>
    <Show when={errorText()}>
      <box paddingLeft={2} paddingRight={2} paddingTop={1} flexShrink={0}>
        <For each={wrapText(errorText(), props.panel.width - 4)}>{(line) => <text fg={theme().text.feedback.error.base} wrapMode="none" truncate>{line}</text>}</For>
      </box>
    </Show>
    <box flexGrow={1} minHeight={0} paddingTop={1} onSizeChange={function (this: { height: number }) { setRows(this.height - 1); }}>
      <scrollbox ref={(node: ScrollBoxRenderable) => (scroll = node)} flexGrow={1} minHeight={0} focused={focused() && props.tab() === "Doctor"} scrollX={false} verticalScrollbarOptions={{ visible: false }}>
        <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1} minWidth={0}>
          <Show when={props.tab() === "Agents"}>
            <Sections tab="Agents" sections={[agentsView()]} />
          </Show>
          <Show when={props.tab() !== "Agents" && loading()}>
            <Line>Loading OMCA state…</Line>
          </Show>
          <Show when={props.tab() !== "Agents" ? value() : undefined}>{(data: Accessor<Snapshot>) => <>
            <Show when={props.tab() === "Tasks"}>
              <Show when={tasksView()} fallback={<Empty title="No run" message="Plan work with /omca-plan, then start it with /omca-start-work. Opening this panel never starts execution." />}>{(view: Accessor<NonNullable<ReturnType<typeof tasksView>>>) => <>
                <Line><span style={{ fg: theme().text.base }}>{progress(view().run.tasks).done}</span><Show when={progress(view().run.tasks).blocked}><span style={{ fg: theme().text.feedback.warning.base }}>{` · ${progress(view().run.tasks).blocked}`}</span></Show></Line>
                <Show when={continuationLine(data().continuation, view().run.tasks)}>{(line: Accessor<{ text: string; warning: boolean }>) => <Prose text={line().text} fg={line().warning ? theme().text.feedback.warning.base : theme().text.muted} />}</Show>
                <Gap />
                <box border={["left"]} borderColor={theme().border.base} paddingLeft={1} marginLeft={1} flexShrink={0}>
                  <Show when={runState(view().run.tasks)?.next} fallback={<For each={wrapText(noRunnableNote(view().run.tasks), room() - 1)}>{(line) => <text fg={theme().text.muted} wrapMode="none">{line}</text>}</For>}>{(next: Accessor<NativeTask>) =>
                    <text fg={theme().text.base} wrapMode="none" truncate><span style={{ fg: theme().text.muted }}>Next </span>{flat(`#${next().id} ${next().subject}`)}</text>}</Show>
                </box>
                <Gap />
                <Sections tab="Tasks" sections={view().sections} />
                <Show when={errors().length > 0}><Gap /></Show>
                <For each={errors()}>{(item) => <Prose text={`${item.name}: ${item.detail}`} fg={theme().text.feedback.error.base} />}</For>
              </>}</Show>
            </Show>
            <Show when={props.tab() === "Evidence"}>
              <Line fg={theme().text.base}><strong>Recorded checks</strong><span style={{ fg: theme().text.muted }}>{` · ${verdictText(data().evidence.verdict)}`}</span></Line>
              <Prose text="Reported command results, not live verification." />
              <Gap always />
              <Show when={evidenceItems().length > 0} fallback={<Prose text="No checks recorded yet. Build, test and lint results appear once they are logged with OMCA's evidence tool." />}>
                <For each={evidenceItems()}>{(item, index) => <Row tab="Evidence" item={item} index={index()} />}</For>
              </Show>
            </Show>
            <Show when={props.tab() === "Notepad"}>
              <Show when={notepadView().length > 0} fallback={<Empty title="No notes yet" message="Learnings, issues, decisions and problems recorded for the current run appear here." />}>
                <Sections tab="Notepad" sections={notepadView()} />
              </Show>
            </Show>
            <Show when={props.tab() === "Doctor"}>
              <Line fg={theme().text.base}><strong>Server health</strong><span style={{ fg: theme().text.muted }}>{` · ${errors().length === 0 ? "no runtime errors" : `${errors().length} ${errors().length === 1 ? "error" : "errors"}`}`}</span></Line>
              <Gap always />
              <For each={data().health.filter((item) => item.name !== "verification")}>{(item) => <box flexDirection="column" flexShrink={0}>
                <Line fg={theme().text.base}>
                  <span style={{ fg: item.state === "error" ? theme().text.feedback.error.base : item.state === "warning" ? theme().text.feedback.warning.base : theme().text.feedback.success.base }}>{`${item.state === "error" ? g.cross : item.state === "warning" ? g.warn : g.check} `}</span>
                  <strong>{plain(item.name)}</strong>
                </Line>
                <Prose text={item.detail} indent={2} />
              </box>}</For>
              <Gap always />
              <Line fg={theme().text.base}><strong>Platform limits</strong></Line>
              <Prose text="Recorded successes are historical, not verification of the current checkout. OpenCode provides no native execution receipts." />
            </Show>
          </>}</Show>
        </box>
      </scrollbox>
    </box>
    <box flexShrink={0}>
      <Show when={docked()}>
        <text fg={theme().background.base} wrapMode="none" flexShrink={0}>{"▀".repeat(Math.max(0, props.panel.width))}</text>
      </Show>
      <box height={1} flexDirection="row" gap={2} paddingLeft={2} paddingRight={2} flexShrink={0}>
        <text fg={focused() ? theme().background.action.primary.focused : theme().text.action.primary.disabled} attributes={focused() ? 0 : TextAttributes.DIM} flexGrow={1} minWidth={0} wrapMode="none" truncate>
          <Show when={hints().left}>{(left: Accessor<Hint>) => <HintText hints={[left()]} />}</Show>
        </text>
        <text fg={focused() ? theme().background.action.primary.focused : theme().text.action.primary.disabled} attributes={focused() ? 0 : TextAttributes.DIM} flexShrink={0} wrapMode="none">
          <HintText hints={hints().right} />
        </text>
      </box>
      <Show when={docked()}><box height={1} flexShrink={0} /></Show>
    </box>
  </box>;
}
