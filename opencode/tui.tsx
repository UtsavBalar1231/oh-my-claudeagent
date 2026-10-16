/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import type { JSX } from "@opentui/solid";
import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Omca, type Snapshot } from "./rpc.ts";
import { commandTab, snapshotReader, targetKey, type ReadState, type Tab, type Target } from "./tui-model.ts";
import { OmcaPanel } from "./tui-panel.tsx";

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
        if (!props.sessionID) return "OMCA";
        const current = state(props.sessionID);
        if (!current || current.phase === "loading") return "OMCA: …";
        if (current.phase === "error") return "OMCA: offline";
        const value = current.value;
        if (!value?.plan) return "OMCA";
        return `OMCA: ${value.plan.tasks.filter((task) => task.checked).length}/${value.plan.tasks.length}`;
      };
      return <text fg={ctx.theme.text.muted} wrapMode="none">{status()}</text>;
    }

    const dispose = [
      ctx.ui.slot({ append: "app", render: () => <Monitor /> }),
      ctx.ui.slot({ append: "session.panel", render: (panel) => <Show when={panel.name === "omca.overview"}><OmcaPanel panel={panel} current={() => state(panel.sessionID)} tab={tab} select={setTab} refresh={() => refresh()} /></Show> }),
      ctx.ui.slot({ append: "prompt.footer.status", render: (input) => <Footer {...input} /> }),
    ];
    return () => dispose.forEach((stop) => stop());
  },
});
