/** @jsxImportSource @opentui/solid */

import { usePlugin } from "@opencode/plugin/tui";
import type { PanelInput } from "@opencode/plugin/tui/context";
import type { JSX } from "@opentui/solid";
import { For, Show, createMemo, type Accessor } from "solid-js";
import { parseEntries } from "../src/core/notepad.ts";
import { fitEnd } from "../src/core/ui-kit.ts";
import type { Snapshot } from "./rpc.ts";
import { plain, tabs, type ReadState, type Tab } from "./tui-model.ts";

type Plan = NonNullable<Snapshot["plan"]>;
type Run = Snapshot["evidence"]["entries"][number];
type Props = {
  panel: PanelInput;
  current: Accessor<ReadState<Snapshot> | undefined>;
  tab: Accessor<Tab>;
  select: (tab: Tab) => void;
  refresh: () => void;
};

const oneLine = (text: string) => plain(text).replace(/\s+/g, " ").trim();
const stamp = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const runType = (type: string) => type === "final_verification" ? "Final check" : type[0]?.toUpperCase() + type.slice(1);
const shortTabs: Record<Tab, string> = { Overview: "Home", Plan: "Plan", Agents: "Agents", Evidence: "Runs", Notepad: "Notes", Doctor: "Health" };

export function OmcaPanel(props: Props): JSX.Element {
  const ctx = usePlugin();
  const theme = () => ctx.theme;
  const value = () => props.current()?.value;
  const width = () => Math.max(16, props.panel.width - 4);
  const clip = (text: string, room = width()) => fitEnd(oneLine(text), Math.max(1, room), "…");
  const currentSession = () => ctx.data.session.get(props.panel.sessionID);
  const sessions = createMemo(() => {
    const family = new Set(ctx.data.session.family(props.panel.sessionID));
    return ctx.data.session.list().filter((session) => family.has(session.id));
  });
  const workers = () => sessions().filter((session) => !!session.parentID);
  const activeWorkers = () => workers().filter((session) => ctx.data.session.status(session.id) === "running").length;
  const runs = () => value()?.evidence.entries.toReversed() ?? [];
  const errors = () => value()?.health.filter((item) => item.state === "error") ?? [];
  const completed = (plan: Plan) => plan.tasks.filter((task) => task.checked).length;
  const waiting = (task: Plan["tasks"][number], plan: Plan) => task.dependencies.filter((number) => !plan.tasks.find((item) => item.number === number)?.checked);
  const nextTask = (plan: Plan) => plan.tasks.find((task) => !task.checked && waiting(task, plan).length === 0) ?? plan.tasks.find((task) => !task.checked);

  function navigate(sessionID: string) {
    if (ctx.ui.tabs.enabled()) ctx.ui.tabs.focus(sessionID);
    else ctx.ui.router.navigate({ type: "session", sessionID });
  }

  async function chooseSession() {
    const selected = await ctx.ui.dialog.select({
      title: "OMCA sessions",
      current: props.panel.sessionID,
      options: sessions().map((session) => ({
        title: oneLine(session.title ?? session.id),
        value: session.id,
        description: `${session.agent?.replace(/^omca-/, "") ?? "session"} · ${ctx.data.session.status(session.id)}`,
      })),
    });
    if (selected) navigate(selected);
  }

  async function inspectRun(entry: Run) {
    await ctx.ui.dialog.alert({
      title: `${runType(entry.type)} · exit ${entry.exitCode}`,
      message: plain(`${entry.command}\n${stamp(entry.at)}\n\n${entry.snippet || "No output recorded."}\n\nReported by: ${entry.verifiedBy ?? "unspecified"}\nPlan digest: ${entry.planSha || "unscoped"}\n\nThis is an attested result, not verification of the current checkout.`),
    });
  }

  async function chooseRun() {
    const entries = runs();
    const index = await ctx.ui.dialog.select({
      title: "Recorded checks",
      options: entries.map((entry, index) => ({ title: oneLine(entry.command), value: index, description: `${runType(entry.type)} · exit ${entry.exitCode} · ${stamp(entry.at)}` })),
    });
    if (index !== undefined && entries[index]) await inspectRun(entries[index]!);
  }

  async function inspectPlan() {
    const plan = value()?.plan;
    if (!plan) return;
    await ctx.ui.dialog.alert({ title: "Plan details", message: plain(`${plan.name}\n${plan.path}\n\nStatus: ${plan.status}\nSHA256: ${plan.sha256}\n\nBound only to this session.`) });
  }

  ctx.keymap.layer(() => ({
    enabled: () => props.panel.focused,
    commands: [
      ...tabs.map((tab, index) => ({ id: `omca.tab.${tab.toLowerCase()}`, title: tab, bind: String(index + 1), run: () => props.select(tab) })),
      { id: "omca.refresh", title: "Refresh OMCA", bind: "r", run: props.refresh },
      { id: "omca.fullscreen", title: "Toggle OMCA fullscreen", bind: "f", run: props.panel.toggleFullscreen },
      { id: "omca.close", title: "Close OMCA", bind: "escape", run: props.panel.close },
      { id: "omca.plan.details", title: "Inspect plan details", bind: "d", enabled: () => props.tab() === "Plan" && !!value()?.plan, run: inspectPlan },
      { id: "omca.agent.select", title: "Open session", bind: "return", enabled: () => props.tab() === "Agents", run: chooseSession },
      { id: "omca.evidence.select", title: "Inspect recorded check", bind: "return", enabled: () => props.tab() === "Evidence" && runs().length > 0, run: chooseRun },
    ],
  }));

  function Section(section: { title: string; detail?: string; children: JSX.Element }): JSX.Element {
    return <box flexDirection="column" gap={1} flexShrink={0} minWidth={0}>
      <text fg={theme().text.muted}><strong>{section.title}</strong><Show when={section.detail}><span>{`  ${section.detail}`}</span></Show></text>
      {section.children}
    </box>;
  }

  function Empty(empty: { title: string; message: string }): JSX.Element {
    return <box flexDirection="column" gap={1} paddingY={1} flexShrink={0}>
      <text fg={theme().text.base}><strong>{empty.title}</strong></text>
      <text fg={theme().text.muted} wrapMode="word">{empty.message}</text>
    </box>;
  }

  function Progress(progress: { plan: Plan }): JSX.Element {
    const total = () => progress.plan.tasks.length;
    const done = () => completed(progress.plan);
    const cells = () => width() < 26 ? 0 : Math.min(32, width() - 22);
    const filled = () => total() === 0 ? 0 : Math.round(done() / total() * cells());
    return <text fg={theme().text.muted}>
      <span style={{ fg: theme().text.action.primary.base }}>{"━".repeat(filled())}</span>{"─".repeat(cells() - filled())}
      <span style={{ fg: theme().text.base }}>{`  ${done()}/${total()}`}</span>{" checked"}
    </text>;
  }

  function RunRow(row: { entry: Run }): JSX.Element {
    const failed = () => row.entry.exitCode !== 0;
    return <box flexDirection="column" flexShrink={0} minWidth={0} onMouseDown={() => void inspectRun(row.entry)}>
      <text fg={theme().text.base}>
        <span style={{ fg: failed() ? theme().text.feedback.error.base : theme().text.feedback.success.base }}>{failed() ? "× " : "✓ "}</span>
        {clip(row.entry.command, width() - 3)}
      </text>
      <text fg={theme().text.muted}>{clip(`  ${runType(row.entry.type)} · exit ${row.entry.exitCode} · ${stamp(row.entry.at)}`)}</text>
    </box>;
  }

  function PlanSummary(summary: { plan: Plan }): JSX.Element {
    return <box flexDirection="column" gap={1} flexShrink={0}>
      <text fg={theme().text.base}><strong>{clip(summary.plan.name, width() - summary.plan.status.length - 2)}</strong><span style={{ fg: theme().text.muted }}>{`  ${summary.plan.status}`}</span></text>
      <Progress plan={summary.plan} />
    </box>;
  }

  return <box flexDirection="column" flexGrow={1} minWidth={0} onMouseDown={props.panel.focus}>
    <box flexDirection="row" justifyContent="space-between" paddingX={2} paddingTop={1} flexShrink={0}>
      <text fg={theme().text.base}><strong>OMCA</strong><span style={{ fg: theme().text.muted }}>{` / ${props.tab()}`}</span></text>
      <text fg={theme().text.muted}>{props.current()?.phase === "error" ? "offline" : props.current()?.stale ? "updating" : ctx.data.session.status(props.panel.sessionID)}</text>
    </box>
    <box flexDirection="row" gap={1} paddingX={2} paddingY={1} flexShrink={0}>
      <For each={tabs}>{(tab, index) => <text
        fg={props.tab() === tab ? theme().text.action.primary.base : theme().text.muted}
        bg={props.tab() === tab ? theme().background.raised.high : theme().background.base}
        onMouseDown={() => props.select(tab)}
      >{`${index() + 1} ${props.panel.width >= 88 ? tab : props.panel.width >= 58 ? shortTabs[tab] : props.tab() === tab ? shortTabs[tab] : ""}`.trimEnd()}</text>}</For>
    </box>
    <Show when={props.current()?.phase === "error"}>
      <box paddingX={2} paddingBottom={1} flexShrink={0}>
        <text fg={theme().text.feedback.error.base} wrapMode="word">{plain(`Could not refresh. ${props.current()?.error ?? "Snapshot unavailable."}${value() ? " Showing the last snapshot." : ""} Press r to retry.`)}</text>
      </box>
    </Show>
    <scrollbox flexGrow={1} minHeight={0} focused={props.panel.focused} scrollX={false}>
      <box flexDirection="column" gap={2} paddingX={2} paddingBottom={1} minWidth={0}>
        <Show when={!props.current() || props.current()?.phase === "loading"}><Empty title="Reading session state" message="Loading the bound plan, recorded checks, and notes." /></Show>
        <Show when={props.tab() === "Agents"}>
          <Section title="Sessions" detail={`${activeWorkers()} working`}>
            <For each={sessions()} fallback={<Empty title="No sessions loaded" message="Delegated sessions appear here when OpenCode discovers them." />}>{(session) => <box flexDirection="column" flexShrink={0} minWidth={0} onMouseDown={() => navigate(session.id)}>
              <text fg={theme().text.base}>
                <span style={{ fg: ctx.data.session.status(session.id) === "running" ? theme().text.action.primary.base : theme().text.muted }}>{session.id === props.panel.sessionID ? "› " : "  "}</span>
                <strong>{clip(session.title ?? session.id, width() - 2)}</strong>
              </text>
              <text fg={theme().text.muted}>{clip(`  ${session.agent?.replace(/^omca-/, "") ?? "session"} · ${ctx.data.session.status(session.id)}${session.id === props.panel.sessionID ? " · current" : ""}${ctx.data.session.cost(session.id) > 0 ? ` · $${ctx.data.session.cost(session.id).toFixed(4)}` : ""}`)}</text>
            </box>}</For>
          </Section>
        </Show>
        <Show when={value()}>{(data: Accessor<Snapshot>) => <>
          <Show when={props.tab() === "Overview"}>
            <box flexDirection="column" flexShrink={0}>
              <text fg={theme().text.base}><strong>{clip(currentSession()?.title ?? "Current session")}</strong></text>
              <text fg={theme().text.muted}>{clip(ctx.ui.format.path(data().directory))}</text>
            </box>
            <Show when={data().plan} fallback={<Empty title="No plan bound" message="Use /omca-plan to plan work, then /omca-start-work with the saved plan when you are ready. Opening this panel never starts execution." />}>
              {(plan: Accessor<Plan>) => <Section title="Current plan">
                <PlanSummary plan={plan()} />
                <Show when={nextTask(plan())} fallback={<text fg={theme().text.muted}>All task boxes are checked. Review acceptance criteria and verification before finishing.</text>}>{(task: Accessor<Plan["tasks"][number]>) => <box flexDirection="column" gap={1} border={["left"]} borderColor={theme().border.base} paddingLeft={1} flexShrink={0}>
                  <text fg={theme().text.muted}>{waiting(task(), plan()).length ? "Waiting on dependencies" : "Next task"}</text>
                  <text fg={theme().text.base} wrapMode="word">{plain(`${task().number}. ${task().label}`)}</text>
                </box>}</Show>
              </Section>}
            </Show>
            <Section title="Recorded checks" detail={`${runs().length} recent`}>
              <For each={runs().slice(0, 3)} fallback={<text fg={theme().text.muted}>No check results recorded.</text>}>{(entry) => <RunRow entry={entry} />}</For>
            </Section>
            <Show when={workers().length > 0}><text fg={theme().text.muted}>{`${activeWorkers()} working · ${workers().length} delegated sessions`}</text></Show>
            <For each={errors()}>{(item) => <text fg={theme().text.feedback.error.base} wrapMode="word">{plain(`${item.name}: ${item.detail}`)}</text>}</For>
          </Show>
          <Show when={props.tab() === "Plan"}>
            <Show when={data().plan} fallback={<Empty title="No plan bound" message="A saved plan appears here after /omca-start-work explicitly binds it to this session." />}>{(plan: Accessor<Plan>) => <>
              <PlanSummary plan={plan()} />
              <Section title="Tasks">
                <For each={plan().tasks}>{(task) => <box flexDirection="column" flexShrink={0}>
                  <text fg={task.checked ? theme().text.muted : theme().text.base} wrapMode="word">
                    <span style={{ fg: task.checked ? theme().text.feedback.success.base : theme().text.muted }}>{task.checked ? "✓ " : waiting(task, plan()).length ? "· " : "○ "}</span>{plain(`${task.number}. ${task.label}`)}
                  </text>
                  <Show when={!task.checked && waiting(task, plan()).length > 0}><text fg={theme().text.muted}>{`  Waiting on ${waiting(task, plan()).join(", ")}`}</text></Show>
                </box>}</For>
              </Section>
              <text fg={theme().text.muted}>Checkbox progress is not verified completion.</text>
            </>}</Show>
          </Show>
          <Show when={props.tab() === "Evidence"}>
            <Section title="Recorded checks" detail={data().evidence.verdict === "historical" ? "matching plan history" : data().evidence.verdict === "stale" ? "earlier plan history" : "no final verification"}>
              <text fg={theme().text.muted} wrapMode="word">Reported command results, not live verification. Select a check for its output and provenance.</text>
              <For each={runs()} fallback={<Empty title="No checks recorded" message="Build, test, and lint results appear after they are logged with OMCA's evidence tool." />}>{(entry) => <RunRow entry={entry} />}</For>
            </Section>
          </Show>
          <Show when={props.tab() === "Notepad"}>
            <For each={data().notepads} fallback={<Empty title="No notes yet" message="Discoveries and decisions recorded for the bound plan appear here." />}>{(note) => <Section title={note.section[0]?.toUpperCase() + note.section.slice(1)}>
              <For each={parseEntries(note.content).toReversed()}>{(entry) => <box flexDirection="column" gap={1} flexShrink={0}>
                <Show when={entry.at !== null}><text fg={theme().text.muted}>{stamp(entry.at!)}</text></Show>
                <text fg={theme().text.base} wrapMode="word">{plain(entry.text)}</text>
              </box>}</For>
            </Section>}</For>
          </Show>
          <Show when={props.tab() === "Doctor"}>
            <Section title="Read-only server health" detail={errors().length === 0 ? "no runtime errors" : `${errors().length} errors`}>
              <For each={data().health.filter((item) => item.name !== "verification")}>{(item) => <box flexDirection="column" flexShrink={0}>
                <text fg={theme().text.base}><span style={{ fg: item.state === "error" ? theme().text.feedback.error.base : theme().text.muted }}>{item.state === "ok" ? "✓ " : item.state === "error" ? "× " : "· "}</span><strong>{item.name}</strong></text>
                <text fg={theme().text.muted} wrapMode="word">{plain(`  ${item.detail}`)}</text>
              </box>}</For>
            </Section>
            <Section title="Platform limits">
              <text fg={theme().text.muted} wrapMode="word">Recorded successes are historical, not verification of the current checkout. OpenCode provides no OMCA Stop veto or native execution receipts.</text>
            </Section>
          </Show>
        </>}</Show>
      </box>
    </scrollbox>
    <box paddingX={2} paddingY={1} flexShrink={0}>
      <text fg={theme().text.muted}>{clip(!props.panel.focused ? "Click panel to focus" : `${props.panel.width >= 58 ? "1–6 views  " : ""}${props.tab() === "Agents" ? "enter open  " : props.tab() === "Evidence" && runs().length ? "enter inspect  " : props.tab() === "Plan" && value()?.plan ? "d details  " : ""}r refresh  ${props.panel.width >= 58 ? "f expand  " : ""}esc close`)}</text>
    </box>
  </box>;
}
