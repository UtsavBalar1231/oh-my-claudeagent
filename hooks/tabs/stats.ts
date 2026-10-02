import type { Subcommand } from "../omca-router.ts";
import { noticeRow, type TabView } from "../pane.ts";

export const command: Subcommand = () => undefined;

export const view: TabView = async (_host, view) => [
  noticeRow(view, { kind: "empty" }, { loading: "", empty: "No delegation statistics have been collected yet." }),
];
