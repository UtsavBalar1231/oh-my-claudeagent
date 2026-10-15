/** @jsxImportSource @opentui/solid */

import { Plugin, usePlugin } from "@opencode/plugin/tui";
import type { PanelInput } from "@opencode/plugin/tui/context";
import type { JSX } from "@opentui/solid";
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import { Omca, type Snapshot } from "./rpc.ts";
import { commandTab, plain, snapshotReader, tabs, targetKey, type ReadState, type Tab, type Target } from "./tui-model.ts";

export default Plugin.define({
  id: "omca.tui",
  setup(ctx) {
    const [tab, setTab] = createSignal<Tab>("Overview");
    const [snapshot, setSnapshot] = createSignal<ReadState<Snapshot>>();
    const rpc = ctx.client.rpc(Omca);
    let refresh = () => {};

    function target(sessionID: string): Target | undefined {
      const session = ctx.data.session.get(sessionID);
      if (!session) return undefined;
      const location = session.location;
      return { sessionID, location };
    }

    function state(sessionID: string) {
      const selected = target(sessionID);
      const current = snapshot();
      return selected && current?.key === targetKey(selected) ? current : undefined;
    }

    function Monitor(): null {
      const reader = snapshotReader<Snapshot>(async (selected, signal) => {
        const value = await rpc.snapshot({ sessionID: selected.sessionID }, { location: selected.location, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }) as Snapshot;
        if (value.sessionID !== selected.sessionID || value.directory !== selected.location.directory) {
          throw new Error("OMCA snapshot does not match the selected session location");
        }
        return value;
      }, setSnapshot);
      refresh = reader.refresh;
      createEffect(() => {
        const route = ctx.ui.router.current();
        reader.select(route.type === "session" ? target(route.sessionID) : undefined);
      });
      createEffect(() => {
        if (ctx.ui.panel.current()?.name === "omca.overview") reader.refresh();
      });
      let unsubscribe = () => {};
      const subscribe = () => {
        unsubscribe();
        unsubscribe = rpc.events.on("updated", (event) => {
          const route = ctx.ui.router.current();
          if (route.type !== "session" || event.data.sessionID !== route.sessionID) return;
          const selected = target(route.sessionID);
          if (selected && selected.location.directory === event.location.directory) reader.refresh();
        });
        reader.refresh();
      };
      subscribe();
      const stopConnected = ctx.data.on("server.connected", subscribe);
      const timer = setInterval(() => {
        if (ctx.ui.panel.current()?.name === "omca.overview") reader.refresh();
      }, 5_000);
      onCleanup(() => {
        clearInterval(timer);
        unsubscribe();
        stopConnected();
        reader.dispose();
        refresh = () => {};
        setSnapshot(undefined);
      });
      return null;
    }

    function open(input?: string) {
      const selected = commandTab(input);
      if (!selected) {
        ctx.ui.toast.show({ title: "OMCA", message: "Usage: /omca [plan|agents|evidence|notepad|doctor]", variant: "warning" });
        return;
      }
      if (ctx.ui.router.current().type !== "session" || !ctx.ui.panel.open("omca.overview")) {
        ctx.ui.toast.show({ title: "OMCA", message: "Open a session to inspect OMCA state.", variant: "info" });
        return;
      }
      setTab(selected);
    }

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "omca.overview",
        title: "Open OMCA overview",
        group: "OMCA",
        palette: true,
        slash: { name: "omca", arguments: true },
        enabled: () => true,
        run: open,
      }],
    }));

    function Footer(props: { sessionID?: string }): JSX.Element {
      const status = () => {
        if (!props.sessionID) return "OMCA: /omca";
        const current = state(props.sessionID);
        if (!current || current.phase === "loading") return "OMCA: loading";
        if (current.phase === "error") return "OMCA: error (use /omca doctor)";
        if (current.stale) return "OMCA: stale";
        const value = current.value;
        if (!value?.plan) return "OMCA: no plan";
        return `OMCA: ${value.plan.tasks.filter((task) => task.checked).length}/${value.plan.tasks.length} | ${value.evidence.verdict}`;
      };
      return <text fg={ctx.theme.text.muted}>{status()}</text>;
    }

    function Panel(props: { panel: PanelInput }): JSX.Element {
      const context = usePlugin();
      const current = () => state(props.panel.sessionID);
      const value = () => current()?.value;
      const sessions = createMemo(() => {
        const family = new Set(context.data.session.family(props.panel.sessionID));
        return context.data.session.list().filter((session) => family.has(session.id));
      });

      function navigate(sessionID: string) {
        if (context.ui.tabs.enabled()) context.ui.tabs.focus(sessionID);
        else context.ui.router.navigate({ type: "session", sessionID });
      }

      async function chooseAgent() {
        const selected = await context.ui.dialog.select({
          title: "OMCA session family",
          current: props.panel.sessionID,
          options: sessions().map((session) => ({
            title: plain(session.title ?? session.id),
            value: session.id,
            description: `${session.agent ?? "session"} | ${context.data.session.status(session.id)} | $${context.data.session.cost(session.id).toFixed(4)}`,
          })),
        });
        if (selected) navigate(selected);
      }

      context.keymap.layer(() => ({
        enabled: () => props.panel.focused,
        commands: [
          ...tabs.map((name, index) => ({ id: `omca.tab.${name.toLowerCase()}`, title: name, bind: String(index + 1), run: () => { setTab(name); } })),
          { id: "omca.refresh", title: "Refresh OMCA", bind: "r", run: () => refresh() },
          { id: "omca.fullscreen", title: "Toggle OMCA fullscreen", bind: "f", run: props.panel.toggleFullscreen },
          { id: "omca.close", title: "Close OMCA", bind: "escape", run: props.panel.close },
          { id: "omca.agent.select", title: "Open session", bind: "return", enabled: () => tab() === "Agents", run: chooseAgent },
        ],
      }));

      return (
        <box flexDirection="column" flexGrow={1} minWidth={0} onMouseDown={props.panel.focus}>
          <box flexDirection="row" flexWrap="wrap" gap={1} flexShrink={0}>
            <For each={tabs}>{(name, index) => (
              <text fg={tab() === name ? context.theme.text.action.primary.base : context.theme.text.muted} onMouseDown={() => setTab(name)}>{tab() === name ? `[${index() + 1} ${name}]` : `${index() + 1} ${name}`}</text>
            )}</For>
          </box>
          <text fg={context.theme.text.muted} wrapMode="word">{`OMCA ${tab()} | r refresh | f fullscreen | Esc close${tab() === "Agents" ? " | Enter open session" : ""}`}</text>
          <Show when={current()?.phase === "loading" || !current()}><text fg={context.theme.text.base}>Loading OMCA state...</text></Show>
          <Show when={current()?.phase === "error"}><text fg={context.theme.text.feedback.error.base} wrapMode="word">{`Error: ${current()?.error ?? "Snapshot unavailable"}`}</text></Show>
          <Show when={current()?.stale}><text fg={context.theme.text.feedback.warning.base}>Stale: refreshing or last refresh failed.</text></Show>
          <scrollbox flexGrow={1} minHeight={0} focused={props.panel.focused} scrollX={false}>
            <box flexDirection="column" gap={1} paddingRight={1}>
              <Show when={tab() === "Agents"}>
                <text fg={context.theme.text.base}>Native sessions (click a row or press Enter)</text>
                <For each={sessions()} fallback={<text fg={context.theme.text.base}>No sessions loaded.</text>}>{(session) => (
                  <text fg={context.theme.text.base} wrapMode="word" onMouseDown={() => navigate(session.id)}>
                    {plain(`${session.id === props.panel.sessionID ? "> " : ""}${session.title ?? session.id}\n${session.agent ?? "session"} | ${context.data.session.status(session.id)} | $${context.data.session.cost(session.id).toFixed(4)}\n${session.id}${session.parentID ? ` | parent ${session.parentID}` : ""}`)}
                  </text>
                )}</For>
              </Show>
              <Show when={value()}>{(data: Accessor<Snapshot>) => (
                <>
                  <Show when={tab() === "Overview"}>
                    <text fg={context.theme.text.base} wrapMode="word">{plain(`${context.data.session.get(props.panel.sessionID)?.title ?? props.panel.sessionID}\n${data().directory}\nPlan: ${data().plan?.name ?? "none"}\nEvidence: ${data().evidence.verdict}\nSession: ${context.data.session.status(props.panel.sessionID)} | $${context.data.session.cost(props.panel.sessionID).toFixed(4)}\nFamily: ${sessions().length} sessions`)}</text>
                    <Show when={data().plan}>{(plan: Accessor<NonNullable<Snapshot["plan"]>>) => <text fg={context.theme.text.base} wrapMode="word">{plain(`${plan().status}: ${plan().tasks.filter((task) => task.checked).length}/${plan().tasks.length} tasks checked`)}</text>}</Show>
                    <For each={data().health.filter((item) => item.state !== "ok")}>{(item) => <text fg={context.theme.text.feedback[item.state === "error" ? "error" : "warning"].base} wrapMode="word">{plain(`${item.state}: ${item.name}: ${item.detail}`)}</text>}</For>
                  </Show>
                  <Show when={tab() === "Plan"}>
                    <Show when={data().plan} fallback={<text fg={context.theme.text.base}>No plan bound to this session.</text>}>{(plan: Accessor<NonNullable<Snapshot["plan"]>>) => (
                      <>
                        <text fg={context.theme.text.base} wrapMode="word">{plain(`${plan().name} | ${plan().status}\n${plan().path}\nSHA256 ${plan().sha256}`)}</text>
                        <For each={plan().tasks} fallback={<text fg={context.theme.text.base}>No numbered tasks.</text>}>{(task) => <text fg={context.theme.text.base} wrapMode="word">{plain(`[${task.checked ? "x" : " "}] ${task.number}. ${task.label}${task.dependencies.length ? `\nDepends on: ${task.dependencies.join(", ")}` : ""}`)}</text>}</For>
                      </>
                    )}</Show>
                  </Show>
                  <Show when={tab() === "Evidence"}>
                    <text fg={context.theme.text.base}>{`Evidence: ${data().evidence.verdict}`}</text>
                    <For each={data().evidence.entries} fallback={<text fg={context.theme.text.base}>No evidence recorded.</text>}>{(entry) => <text fg={context.theme.text.base} wrapMode="word">{plain(`${entry.type} | exit ${entry.exitCode} | ${new Date(entry.at).toString()}\n${entry.command}\n${entry.snippet}\nVerifier: ${entry.verifiedBy ?? "unspecified"}\nPlan SHA: ${entry.planSha || "none"}`)}</text>}</For>
                  </Show>
                  <Show when={tab() === "Notepad"}>
                    <For each={data().notepads} fallback={<text fg={context.theme.text.base}>No notepads for this plan.</text>}>{(note) => <text fg={context.theme.text.base} wrapMode="word">{plain(`${note.section}\n${note.content}`)}</text>}</For>
                  </Show>
                  <Show when={tab() === "Doctor"}>
                    <text fg={context.theme.text.base}>Read-only server health</text>
                    <For each={data().health} fallback={<text fg={context.theme.text.base}>No health checks returned.</text>}>{(item) => <text fg={item.state === "ok" ? context.theme.text.feedback.success.base : context.theme.text.feedback[item.state].base} wrapMode="word">{plain(`${item.state}: ${item.name}\n${item.detail}`)}</text>}</For>
                  </Show>
                </>
              )}</Show>
            </box>
          </scrollbox>
        </box>
      );
    }

    const dispose = [
      ctx.ui.slot({ append: "app", render: () => <Monitor /> }),
      ctx.ui.slot({ append: "session.panel", render: (panel) => <Show when={panel.name === "omca.overview"}><Panel panel={panel} /></Show> }),
      ctx.ui.slot({ append: "prompt.footer.status", render: (input) => <Footer {...input} /> }),
    ];
    return () => dispose.forEach((stop) => stop());
  },
});
