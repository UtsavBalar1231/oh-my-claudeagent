/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import type { PanelInput } from "@opencode/plugin/tui/context";
import type { JSX } from "@opentui/solid";
import { Show, createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import { glyphTier, glyphs } from "../src/core/ui-kit.ts";
import { Omca, type Snapshot } from "./rpc.ts";
import { PANEL, commandTab, footerStatus, snapshotReader, targetKey, type ReadState, type Tab, type Target } from "./tui-model.ts";
import { OmcaPanel } from "./tui-panel.tsx";

export default Plugin.define({
  id: "omca.tui",
  setup(ctx) {
    const [view, updateView] = ctx.storage.memory("panel", { initial: { tabs: {} as Record<string, Tab>, fullscreen: false } });
    const [snapshot, setSnapshot] = createSignal<ReadState<Snapshot>>();
    const rpc = ctx.client.rpc(Omca);
    const g = glyphs(glyphTier(process.env.OMCA_GLYPHS));
    let refresh = (_byUser?: boolean) => {};
    let live: PanelInput | undefined;

    const tabOf = (sessionID: string): Tab => view.tabs[sessionID] ?? "Tasks";
    const selectTab = (sessionID: string, tab: Tab) => updateView((draft) => { draft.tabs[sessionID] = tab; });

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
        if (ctx.ui.panel.current()?.name === PANEL) reader.refresh();
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
        if (ctx.ui.panel.current()?.name === PANEL) reader.refresh();
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
      const asked = input?.trim().replace(/^\/omca\b/i, "").trim() ?? "";
      const selected = commandTab(asked);
      if (!selected) {
        ctx.ui.toast.show({ title: "OMCA", message: "Usage: /omca [tasks|agents|evidence|notepad|doctor]", variant: "warning" });
        return;
      }
      ctx.ui.dialog.clear();
      const route = ctx.ui.router.current();
      if (route.type !== "session") {
        ctx.ui.toast.show({ title: "OMCA", message: "Open a session to inspect OMCA state.", variant: "info" });
        return;
      }
      const current = ctx.ui.panel.current();
      const panel = current?.name === PANEL && current.sessionID === route.sessionID ? live : undefined;
      if (panel) {
        if (panel.focused && (asked === "" || selected === tabOf(route.sessionID))) {
          ctx.ui.panel.close();
          return;
        }
        if (asked !== "") selectTab(route.sessionID, selected);
        panel.focus();
        return;
      }
      if (!ctx.ui.panel.open(PANEL, { presentation: view.fullscreen ? "fullscreen" : "panel" })) {
        ctx.ui.toast.show({ title: "OMCA", message: "Open a session to inspect OMCA state.", variant: "info" });
        return;
      }
      selectTab(route.sessionID, selected);
    }

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "omca.overview",
        title: "Open OMCA overview",
        group: "OMCA",
        palette: true,
        slash: { name: "omca", arguments: true },
        run: open,
      }],
    }));

    function Footer(props: { sessionID?: string; mode: "normal" | "shell"; showDetails: boolean }): JSX.Element {
      const status = () => {
        if (!props.sessionID || props.mode !== "normal" || !props.showDetails) return undefined;
        const value = state(props.sessionID)?.value;
        return value?.run ? footerStatus(value.run.tasks, value.continuation, g) : undefined;
      };
      return <Show when={status()}>{(parts: Accessor<ReturnType<typeof footerStatus>>) => <box flexShrink={0}>
        <text fg={ctx.theme.text.muted} wrapMode="none" truncate>
          {parts().count}
          <Show when={parts().blocked}><span style={{ fg: ctx.theme.text.feedback.warning.base }}>{parts().blocked}</span></Show>
          <Show when={parts().hold}><span style={{ fg: ctx.theme.text.feedback.warning.base }}>{parts().hold}</span></Show>
        </text>
      </box>}</Show>;
    }

    function Panel(props: { panel: PanelInput }): JSX.Element {
      live = props.panel;
      onCleanup(() => {
        if (live === props.panel) live = undefined;
      });
      return <OmcaPanel
        panel={props.panel}
        glyphs={g}
        current={() => state(props.panel.sessionID)}
        tab={() => tabOf(props.panel.sessionID)}
        select={(tab) => selectTab(props.panel.sessionID, tab)}
        refresh={() => refresh(true)}
        toggleFullscreen={() => {
          const fullscreen = props.panel.presentation === "panel";
          props.panel.toggleFullscreen();
          updateView((draft) => { draft.fullscreen = fullscreen; });
        }}
      />;
    }

    const dispose = [
      ctx.ui.slot({ append: "app", render: () => <Monitor /> }),
      ctx.ui.slot({ append: "session.panel", render: (panel) => <Show when={panel.name === PANEL}><Panel panel={panel} /></Show> }),
      ctx.ui.slot({ append: "prompt.footer.status", render: (input) => <Footer {...input} /> }),
    ];
    return () => dispose.forEach((stop) => stop());
  },
});
