import { noticeRow, type TabView } from "../pane.ts";

export const view: TabView = async (_host, view) => [
  noticeRow(view, { kind: "empty" }, { loading: "", empty: "No feedback has been recorded in this session." }),
];
