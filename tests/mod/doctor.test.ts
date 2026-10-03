import type { On, RenderElement } from "claude-code";
import { expect, test } from "claude-code/testing";
import { joinPath } from "../../src/core/path.ts";
import { usableColumns } from "../../src/core/ui-kit.ts";
import { bodyColumns, cellsAcross, LAYOUTS, pane, POSIX, ROOT, rows, run, SESSION, SIZES, type Size, topRows, type World, world, write } from "./world.ts";

const NOW_S = Date.UTC(2026, 9, 2, 12, 0, 0) / 1000;
const USER = {
  advisorModel: "fable",
  statusLine: { type: "command", command: "omca-statusline" },
};
const USER_TEXT = `${JSON.stringify(USER, null, 2)}\n`;
const WIDE = { columns: 200, rows: 50, placement: "dock" } as const;
const PAD = " ".repeat(23);

type Engine = World & { writes: string[]; release: () => void; started: Promise<void> };

// The calls world.ts leaves out: a held `bun --version`, ast-grep found only as sg, the engine
// version unless denied, and writes recorded in order, refused for any path in `refuse`.
function engine(on: On, w: World, options: { hold?: boolean; refuse?: readonly string[]; isVersionDenied?: () => boolean } = {}): Engine {
  let release = () => {};
  let started = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const e: Engine = Object.assign(w, { writes: [], release, started: new Promise<void>((resolve) => (started = resolve)) });
  const output = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } });
  on("process.run", async (_$, call) => {
    if (call.argv[0] === "bun") {
      started();
      if (options.hold === true) await held;
      return output("1.4.2\n");
    }
    return call.argv[0] === "sg" ? output("ast-grep 0.39.0\n") : { deny: "spawn ast-grep ENOENT" };
  });
  on("session.version", () =>
    options.isVersionDenied?.() === true ? { deny: "version unavailable" } : { value: { version: "2.1.288", base: "2.1.288" } },
  );
  on("fs.write", (_$, call) => {
    const path = w.spelled(call.path);
    e.writes.push(path);
    if (options.refuse?.includes(path) === true) return { deny: "EACCES: permission denied" };
    write(w, path, call.text);
    return { value: undefined };
  });
  return e;
}

type Node = { type: string; props?: Record<string, unknown>; children?: unknown };
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && "type" in value;
const childrenOf = (node: Node): unknown[] => (Array.isArray(node.children) ? node.children : node.children === undefined ? [] : [node.children]);
const textOf = (element: unknown): string => (typeof element === "string" ? element : isNode(element) ? childrenOf(element).map(textOf).join("") : "");

// Every row the tree takes in the body, a column Box spread into the rows it holds.
function lines(element: unknown): string[] {
  if (!isNode(element)) return [textOf(element)];
  if (element.type === "Box" && element.props?.["flexDirection"] === "column") return childrenOf(element).flatMap(lines);
  return [textOf(element)];
}

const bodyLines = (tree: RenderElement): string[] => topRows(tree).flatMap(lines);

const local = (s: number) => new Date(s * 1000).toTimeString().slice(0, 5);

function body(tree: RenderElement): string[] {
  const drawn = rows(tree);
  return drawn.slice(drawn.findIndex((row) => row.startsWith("r: ")));
}

const CHECKS = [
  " ✓ OK    Claude Code   2.1.288 meets the 2.1.288 floor",
  " ✓ OK    bun           bun 1.4.2 is on PATH",
  " ✓ OK    omca server   Last hook call 2 min ago",
  " ✓ OK    ast-grep      sg 0.39.0 is on PATH",
  " ✓ OK    Options       showBand on, guardMode deny",
  " ✓ OK    Agent models  Each agent keeps the model tier it declares",
  " ✓ OK    Effort cap    No maxEffortLevel, so agents run at the effort they declare",
  " ✓ OK    Mod policy    Mods you install may load",
  " ✓ OK    Hooks         Neither disableAllHooks nor allowManagedHooksOnly is set",
  " ✓ OK    Output style  OMCA Default is forced by the plugin",
  " ✓ OK    Advisor       advisorModel fable, and nothing here keeps it off",
];
const STATUS_ROW = ` ! WARN  Status line   No refreshInterval, so it redraws on events only and goes${PAD}stale while agents run${PAD}i: Add refreshInterval 5`;

for (const layout of LAYOUTS) {
  const suffix = layout === POSIX ? "" : ` (${layout.name})`;
  const SETTINGS = layout.settings;
  const CLAUDE_MD = joinPath(layout.platform, layout.home, ".claude", "CLAUDE.md");
  const FILES = {
    [`${layout.root}/.omca/state/session/${SESSION}.json`]: JSON.stringify({ session_id: SESSION, last_hook_at: NOW_S - 120, verification: null }),
    [CLAUDE_MD]: "# Mine\n",
    [SETTINGS]: USER_TEXT,
  };

  test(`/omca doctor opens the Doctor tab, draws the loading state while the checks run, then one marked row per check, problems first${suffix}`, { options: { guardMode: "deny" } }, async ($, on) => {
    const w = engine(on, world(on, FILES, structuredClone(USER), {}, layout), { hold: true });

    const pending = $.command.run(run("doctor", 120));
    await w.started;
    const ui = await $.ui.mount(pane("terminal", WIDE));
    expect(rows(await ui.drawn()).at(-1)).toBe("Running the checks…");
    w.release();
    expect(await pending).toEqual({});

    expect(w.opened).toEqual([{ id: "omca", title: "OMCA", focus: true, closeOnEscape: true, rows: 12, columns: 56 }]);
    expect(body(await ui.drawn())).toEqual([
      `r: Run again   ! 2 warn  ✓ 11 ok  checked ${local(NOW_S)}`,
      " ! WARN  OMCA          Could not read this mod's version from its manifest",
      STATUS_ROW,
      ...CHECKS,
    ]);
    expect(w.reads).not.toContain(CLAUDE_MD);
    expect(w.writes).toEqual([]);

    const manifest = w.reads.find((path) => path.endsWith("/.claude-plugin/plugin.json")) ?? "";
    write(w, manifest, '{ "name": "oh-my-claudeagent", "version": "3.0.0" }');
    await ui.press({ key: "r" });
    expect(body(await ui.drawn()).slice(0, 3)).toEqual([
      `r: Run again   ! 1 warn  ✓ 12 ok  checked ${local(NOW_S)}`,
      STATUS_ROW,
      " ✓ OK    OMCA          oh-my-claudeagent 3.0.0 is loaded",
    ]);
    await ui.unmount();
  });

  test(`i backs up settings.json, then adds refreshInterval inside statusLine at the file's indent${suffix}`, async ($, on) => {
    const w = engine(on, world(on, FILES, structuredClone(USER), {}, layout));
    await $.command.run(run("doctor", 120));
    const ui = await $.ui.mount(pane("terminal", WIDE));

    await ui.press({ key: "i" });

    const after = USER_TEXT.replace('"command": "omca-statusline"\n', '"command": "omca-statusline",\n    "refreshInterval": 5\n');
    expect(w.writes).toEqual([`${SETTINGS}.omca-bak`, SETTINGS]);
    expect(w.files.get(`${SETTINGS}.omca-bak`)?.text).toBe(USER_TEXT);
    expect(w.files.get(SETTINGS)?.text).toBe(after);
    expect(body(await ui.drawn()).slice(1, 14)).toEqual([
      "✓ Added refreshInterval 5 to statusLine in ~/.claude/settings.json",
      "  Backup: ~/.claude/settings.json.omca-bak",
      "  --- ~/.claude/settings.json.omca-bak",
      "  +++ ~/.claude/settings.json",
      "  @@ -2,6 +2,7 @@",
      "   \"advisorModel\": \"fable\",",
      "   \"statusLine\": {",
      "     \"type\": \"command\",",
      "-    \"command\": \"omca-statusline\"",
      "+    \"command\": \"omca-statusline\",",
      "+    \"refreshInterval\": 5",
      "   }",
      " }",
    ].map((line, index) => (index < 5 ? line : `  ${line}`)));
    expect((await ui.find({ type: "Text", text: '  -    "command": "omca-statusline"' }))?.props["color"]).toBe("error");
    expect((await ui.find({ type: "Text", text: '  +    "refreshInterval": 5' }))?.props["color"]).toBe("success");
    expect((await ui.find({ type: "Text", text: "  --- ~/.claude/settings.json.omca-bak" }))?.props["dimColor"]).toBe(true);
    expect(await ui.find({ key: "i" })).toBeUndefined();
    await ui.unmount();
  });

  test(`a settings.json with a byte order mark is fixed, and keeps its mark${suffix}`, async ($, on) => {
    const mark = String.fromCharCode(0xfeff);
    const w = engine(on, world(on, { ...FILES, [SETTINGS]: `${mark}${USER_TEXT}` }, structuredClone(USER), {}, layout));
    await $.command.run(run("doctor", 120));
    const ui = await $.ui.mount(pane("terminal", WIDE));

    await ui.press({ key: "i" });

    const after = `${mark}${USER_TEXT.replace('"command": "omca-statusline"\n', '"command": "omca-statusline",\n    "refreshInterval": 5\n')}`;
    expect(w.writes).toEqual([`${SETTINGS}.omca-bak`, SETTINGS]);
    expect(w.files.get(`${SETTINGS}.omca-bak`)?.text).toBe(`${mark}${USER_TEXT}`);
    expect(w.files.get(SETTINGS)?.text).toBe(after);
    await ui.unmount();
  });

  test(`a fix refuses a file that changed since the check, and writes nothing${suffix}`, async ($, on) => {
    const w = engine(on, world(on, FILES, structuredClone(USER), {}, layout));
    await $.command.run(run("doctor", 120));
    const ui = await $.ui.mount(pane("terminal", WIDE));

    write(w, SETTINGS, `${USER_TEXT}\n`);
    await ui.press({ key: "i" });

    expect(w.writes).toEqual([]);
    expect(w.files.get(SETTINGS)?.text).toBe(`${USER_TEXT}\n`);
    expect(body(await ui.drawn())[1]).toBe(
      "✗ ~/.claude/settings.json changed since the check, so it was left alone; press r to check again",
    );
    await ui.unmount();
  });

  test(`a failed backup aborts the fix before the file is touched${suffix}`, async ($, on) => {
    const w = engine(on, world(on, FILES, structuredClone(USER), {}, layout), { refuse: [`${SETTINGS}.omca-bak`] });
    await $.command.run(run("doctor", 120));
    const ui = await $.ui.mount(pane("terminal", WIDE));

    await ui.press({ key: "i" });

    expect(w.writes).toEqual([`${SETTINGS}.omca-bak`]);
    expect(w.files.get(SETTINGS)?.text).toBe(USER_TEXT);
    expect(body(await ui.drawn())[1]).toBe(
      "✗ Could not write the backup ~/.claude/settings.json.omca-bak, so ~/.claude/settings.json is unchanged: EACCES: permission denied",
    );
    expect(await ui.find({ key: "i" })).toBeDefined();
    await ui.unmount();
  });

  test(`CLAUDE_CONFIG_DIR moves the settings file the doctor reads and fixes, and HOME/.claude is never read${suffix}`, async ($, on) => {
    const config = layout === POSIX ? "/cfg" : "D:\\cfg";
    const moved = joinPath(layout.platform, config, "settings.json");
    const files = { [moved]: USER_TEXT, [SETTINGS]: "{}\n" };
    const w = engine(on, world(on, files, structuredClone(USER), { CLAUDE_CONFIG_DIR: config }, layout));
    await $.command.run(run("doctor", 120));
    const ui = await $.ui.mount(pane("terminal", WIDE));

    expect(body(await ui.drawn()).find((row) => row.startsWith(" ! WARN  Status line"))).toBe(STATUS_ROW);
    await ui.press({ key: "i" });
    expect(w.writes).toEqual([`${moved}.omca-bak`, moved]);
    expect(w.reads.filter((path) => path.startsWith(`${layout.home}/.claude/`) || path.startsWith(`${layout.home}\\.claude`))).toEqual([]);
    await ui.unmount();
  });

  test(`the tab's empty state offers r, and a failed run shows its reason with r to run again${suffix}`, async ($, on) => {
    let isDenied = false;
    engine(on, world(on, FILES, structuredClone(USER), {}, layout), { isVersionDenied: () => isDenied });
    await $.command.run(run(""));
    const ui = await $.ui.mount(pane("desktop", { columns: 120, rows: 40, placement: "dock" }));
    await ui.press({ key: "7" });
    expect(rows(await ui.drawn()).slice(-2)).toEqual(["The doctor checks have not run in this session.", "r: Run checks"]);

    isDenied = true;
    await ui.press({ key: "r" });
    expect(rows(await ui.drawn()).slice(-2)).toEqual(["✗ The checks failed: version unavailable", "r: Run again"]);
    isDenied = false;
    await ui.press({ key: "r" });
    expect(rows(await ui.drawn()).find((row) => row.startsWith(" ! WARN  Status line"))).toBe(
      " ! WARN  Status line  No refreshInterval, so it redraws on events only  and goes stale while agents run  i: Add refreshInterval 5",
    );
    await ui.unmount();
  });

  test(`the tab's hotkeys are r and i, never a pane key, and every row fits at 80, 120 and 200 columns on both surfaces${suffix}`, async ($, on) => {
    const w = engine(on, world(on, FILES, structuredClone(USER), {}, layout));
    await $.command.run(run("doctor"));
    w.reads.length = 0;

    for (const size of SIZES) {
      for (const surface of ["terminal", "desktop"] as const) {
        const room = usableColumns(bodyColumns(size));
        const ui = await $.ui.mount(pane(surface, size));
        const keys = async () =>
          (await ui.findAll({ type: "Button" })).map((button) => String(button.props["hotkey"])).filter((key) => !/^[1-9]$/.test(key)).sort();
        if (w.writes.length === 0) {
          expect(await keys()).toEqual(["i", "r"]);
          await ui.press({ key: "i" });
          w.settings = { ...structuredClone(USER), statusLine: { ...USER.statusLine, refreshInterval: 5 } };
          await ui.press({ key: "r" });
        }
        expect(await keys()).toEqual(["r"]);
        for (const child of topRows(await ui.drawn())) {
          expect(cellsAcross(child), `${size.columns} ${size.placement} ${surface}`).toBeLessThanOrEqual(room);
        }
        await ui.unmount();
      }
    }
    expect(w.writes).toEqual([`${SETTINGS}.omca-bak`, SETTINGS]);
  });

  test(`OMCA_ASCII draws the doctor's marks and separators from the ASCII set${suffix}`, { options: { guardMode: "deny" } }, async ($, on) => {
    engine(on, world(on, FILES, structuredClone(USER), { OMCA_ASCII: "1" }, layout));
    await $.command.run(run("doctor", 80));
    const ui = await $.ui.mount(pane("terminal", { columns: 80, rows: 40, placement: "inline" }));
    const drawn = body(await ui.drawn());
    expect(drawn[0]).toBe(`r: Run again   ! 2 warn  + 11 ok  checked ${local(NOW_S)}`);
    expect(drawn[2]).toBe(`[! WARN] OMCA          Could not read this mod's version from its${PAD}manifest`);
    expect(drawn).toContain("[+ OK]   Claude Code   2.1.288 meets the 2.1.288 floor");
    expect(drawn.at(-2)).toBe("  v 9 more - ^v scroll");
    const isAscii = (row: string) => [...row].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) < 127);
    expect(rows(await ui.drawn()).filter((row) => !isAscii(row))).toEqual([]);
    await ui.unmount();
  });
}

test("the Options row reports the options the mod loaded with, whatever settings.json holds", { options: { showBand: false } }, async ($, on) => {
  const configs = { pluginConfigs: { "oh-my-claudeagent@omca": { options: { showBand: true, guardMode: "deny" } } } };
  engine(on, world(on, {}, configs));
  await $.command.run(run("doctor", 120));
  const ui = await $.ui.mount(pane("terminal", WIDE));

  expect(body(await ui.drawn()).find((row) => row.includes("Options"))).toBe(" ✓ OK    Options       showBand off, guardMode dialog");
  await ui.unmount();
});

const SCROLL = { component: "Pane", requestId: "omca", offset: 0, origin: { kind: "person" } } as const;

for (const [placement, columns, expectedCut] of [
  ["dock", 120, [true, true, false]],
  ["inline", 80, [true, true, true]],
] as const) {
  test(`${placement}: at 30, 40 and 50 rows the Doctor list fits the body, names what is below, and scrolls`, async ($, on) => {
    engine(on, world(on, {}, {}));
    const handed: number[] = [];
    on("ui.scroll", (_$, e) => (handed.push(e.by), {}));
    await $.command.run(run("doctor", 120));

    const cut: boolean[] = [];
    for (const rowsAvailable of [30, 40, 50]) {
      const ui = await $.ui.mount(pane("terminal", { columns, rows: rowsAvailable, placement }));
      const drawn = bodyLines(await ui.drawn());
      const bodyRows = placement === "dock" ? rowsAvailable - 4 : Math.max(7, Math.min(12, Math.floor(rowsAvailable / 3) - 2));
      const checks = (await ui.findAll({ type: "Box" })).filter((box) => box.key?.startsWith("check-")).length;
      const below = drawn.filter((row) => row.includes("more")).at(-1);
      cut.push(below !== undefined);
      if (below === undefined) {
        expect(checks).toBe(13);
        expect(drawn.length).toBeLessThanOrEqual(bodyRows);
      } else {
        expect(below).toBe(`  ↓ ${13 - checks} more · ↑↓ scroll`);
        expect(drawn.length, "the body, and the row that lets the engine scroll").toBe(bodyRows + 1);
      }
      await ui.unmount();
    }
    expect(cut).toEqual([...expectedCut]);
    expect(handed).toEqual([]);
  });
}

test("the arrows, a page key and the wheel move the Doctor list by whole checks, and the engine is left alone", async ($, on) => {
  engine(on, world(on, {}, {}));
  const handed: number[] = [];
  on("ui.scroll", (_$, e) => (handed.push(e.by), {}));
  await $.command.run(run("doctor", 120));
  const size: Size = { columns: 120, rows: 30, placement: "dock" };
  const ui = await $.ui.mount(pane("terminal", size));
  const scroll = (by: number) => $.ui.scroll({ ...SCROLL, by, bodyRows: 26, contentRows: 27 });
  const titles = async () => (await ui.findAll({ type: "Box" })).flatMap((box) => (box.key?.startsWith("check-") === true ? [box.key] : []));
  const edges = async () => bodyLines(await ui.drawn()).filter((row) => row.includes("more"));

  expect((await titles())[0]).toBe("check-mod");
  expect(await edges()).toEqual(["  ↓ 6 more · ↑↓ scroll"]);

  await scroll(1);
  expect((await titles())[0]).toBe("check-server");
  expect(await edges()).toEqual(["  ↑ 1 more", "  ↓ 5 more · ↑↓ scroll"]);

  await scroll(26);
  expect(await edges()).toEqual(["  ↑ 4 more"]);
  expect((await titles()).at(-1)).toBe("check-style");

  await scroll(1);
  expect(await edges()).toEqual(["  ↑ 4 more"]);

  await scroll(-3);
  expect(await edges()).toEqual(["  ↑ 3 more", "  ↓ 2 more · ↑↓ scroll"]);

  await scroll(-100);
  expect((await titles())[0]).toBe("check-mod");
  expect(handed).toEqual([]);
  await ui.unmount();
});

test("Home and End send the Doctor list to its first and last check even when one window is far smaller than the list", async ($, on) => {
  engine(on, world(on, {}, {}));
  await $.command.run(run("doctor", 120));
  const ui = await $.ui.mount(pane("terminal", { columns: 60, rows: 30, placement: "inline" }));
  const contentRows = bodyLines(await ui.drawn()).length;
  const key = (by: number) => $.ui.scroll({ ...SCROLL, by, bodyRows: contentRows - 1, contentRows });
  const titles = async () => (await ui.findAll({ type: "Box" })).flatMap((box) => (box.key?.startsWith("check-") === true ? [box.key] : []));
  const edges = async () => bodyLines(await ui.drawn()).filter((row) => row.includes("more"));

  expect(contentRows).toBe(9);
  expect(await titles()).toEqual(["check-mod"]);
  expect(await edges()).toEqual(["  ↓ 12 more · ↑↓ scroll"]);

  await key(contentRows);
  expect(await titles()).toEqual(["check-style"]);
  expect(await edges()).toEqual(["  ↑ 12 more"]);

  await key(-contentRows);
  expect(await titles()).toEqual(["check-mod"]);
  expect(await edges()).toEqual(["  ↓ 12 more · ↑↓ scroll"]);

  await key(contentRows - 1);
  expect(await titles()).not.toEqual(["check-style"]);
  expect(await edges()).toHaveLength(2);
  await ui.unmount();
});

test("a Doctor list that fits leaves the arrows to the engine, and so does every other tab", async ($, on) => {
  engine(on, world(on, {}, {}));
  const handed: number[] = [];
  on("ui.scroll", (_$, e) => (handed.push(e.by), {}));
  await $.command.run(run("doctor", 120));
  const ui = await $.ui.mount(pane("terminal", { columns: 120, rows: 50, placement: "dock" }));

  await $.ui.scroll({ ...SCROLL, by: 1, bodyRows: 46, contentRows: 46 });
  expect(handed).toEqual([1]);

  await ui.unmount();
  const small = await $.ui.mount(pane("terminal", { columns: 120, rows: 30, placement: "dock" }));
  await small.press({ key: "1" });
  await $.ui.scroll({ ...SCROLL, by: 2, bodyRows: 26, contentRows: 40 });
  expect(handed).toEqual([1, 2]);
  await small.unmount();
});

function styleRow(drawn: RenderElement): string | undefined {
  const all = bodyLines(drawn);
  const start = all.findIndex((row) => / (?:WARN|OK) +Output style/.test(row));
  if (start < 0) return undefined;
  const length = all.slice(start + 1).findIndex((row) => /^ [!✓·] [A-Z]+ /.test(row));
  return all
    .slice(start, length < 0 ? undefined : start + 1 + length)
    .join(" ")
    .replace(/\s+/g, " ");
}

test("the Output style row is ok while the plugin forces its style, and says nothing more", async ($, on) => {
  engine(on, world(on, {}, { outputStyle: "Explanatory" }));
  await $.command.run(run("doctor", 120));
  const ui = await $.ui.mount(pane("terminal", WIDE));

  expect(styleRow(await ui.drawn())).toBe(" ✓ OK Output style OMCA Default is forced by the plugin");
  await ui.unmount();
});

test("the Output style row is ok when the user opted out of the forced style, and names what applies", async ($, on) => {
  const w = world(on, {}, {
    outputStyle: "Explanatory",
    pluginConfigs: { "oh-my-claudeagent@omca": { options: { disableForceOrchestrationStyle: true } } },
  });
  w.style = w.style?.replace("force-for-plugin: true\n", "");
  engine(on, w);
  await $.command.run(run("doctor", 120));
  const ui = await $.ui.mount(pane("terminal", WIDE));

  expect(styleRow(await ui.drawn())).toBe(" ✓ OK Output style disableForceOrchestrationStyle is on, so your outputStyle Explanatory applies");
  await ui.unmount();
});

test("the Output style row warns with the active style and the way back when the force is gone and nobody opted out", async ($, on) => {
  const w = world(on, {}, { outputStyle: "Explanatory" });
  w.style = w.style?.replace("force-for-plugin: true\n", "");
  engine(on, w);
  await $.command.run(run("doctor", 120));
  const ui = await $.ui.mount(pane("terminal", WIDE));

  const row = styleRow(await ui.drawn()) ?? "";
  expect(row).toStartWith(" ! WARN Output style Explanatory is the active output style and OMCA Default is not forced;");
  expect(row).toContain("update or reinstall the plugin to restore its force-for-plugin line");
  expect(row).toContain("or choose OMCA Default in /config");
  await ui.unmount();
});

function node(element: unknown, key: string): Node | undefined {
  if (!isNode(element)) return undefined;
  if (element.props?.["key"] === key) return element;
  return childrenOf(element).reduce<Node | undefined>((found, child) => found ?? node(child, key), undefined);
}

const piece = (props: Record<string, unknown>, run: string) => ({ type: "Text", ...(Object.keys(props).length === 0 ? {} : { props }), children: [run] });
const line = (...pieces: unknown[]) => ({ type: "Text", props: { wrap: "truncate-end" }, children: pieces });

test("a row is a chip with the level's glyph and word on its tone, the label bold, and it lights on hover; the head counts each level in its tone", async ($, on) => {
  const status = { [`${ROOT}/.omca/state/session/${SESSION}.json`]: JSON.stringify({ session_id: SESSION, last_hook_at: NOW_S - 120 }) };
  engine(on, world(on, status, structuredClone(USER)));
  await $.command.run(run("doctor", 120));
  const ui = await $.ui.mount(pane("terminal", WIDE));
  const drawn = await ui.drawn();

  expect(childrenOf(node(drawn, "head") ?? { type: "" })[1]).toEqual(
    line(
      piece({ color: "warning" }, "! 2 warn"),
      piece({}, "  "),
      piece({ color: "success" }, "✓ 11 ok"),
      piece({ color: "inactive" }, `  checked ${local(NOW_S)}`),
    ),
  );
  expect(topRows(drawn)).toContainEqual({
    type: "Box",
    props: { key: "check-engine", flexDirection: "column" },
    hover: { backgroundColor: "selectionBg" },
    children: [
      line(
        piece({ color: "inverseText", backgroundColor: "success", bold: true }, " ✓ OK "),
        piece({}, "   "),
        piece({ bold: true }, "Claude Code   "),
        piece({}, "2.1.288 meets the 2.1.288 floor"),
      ),
    ],
  });
  expect(childrenOf(node(drawn, "check-mod") ?? { type: "" })[0]).toEqual(
    line(
      piece({ color: "inverseText", backgroundColor: "warning", bold: true }, " ! WARN "),
      piece({}, " "),
      piece({ bold: true }, "OMCA          "),
      piece({}, "Could not read this mod's version from its manifest"),
    ),
  );
  await ui.unmount();
});

test("a check that names a command offers it on its own key, which fills the prompt and never submits", async ($, on) => {
  engine(on, world(on, {}, {}));
  const fills: string[] = [];
  on("prompt.fill", (_$, e) => (fills.push(e.text), { isFilled: true }));
  await $.command.run(run("doctor", 120));
  const ui = await $.ui.mount(pane("terminal", WIDE));

  expect(node(await ui.drawn(), "action-advisor-0")).toEqual({
    type: "Box",
    props: { key: "action-advisor-0", flexDirection: "row" },
    children: [
      piece({}, " ".repeat(23)),
      { type: "Button", props: { key: "prompt-advisor", hotkey: "a", label: "Use /advisor fable", plain: true }, press: expect.anything() },
    ],
  });
  expect(rows(await ui.drawn()).filter((row) => row.includes(": Use /"))).toEqual([
    ` ! WARN  omca server   No hook has reached the server in this session yet${PAD}m: Use /mcp`,
    ` · INFO  Advisor       No advisorModel; /advisor fable turns the advisor on${PAD}a: Use /advisor fable`,
    ` · INFO  Status line   No statusLine is set${PAD}s: Use /oh-my-claudeagent:omca-setup`,
  ]);

  const offered = (await ui.findAll({ type: "Button" })).flatMap((found) => (found.key?.startsWith("prompt-") === true ? [[found.key, found.props["hotkey"]]] : []));
  expect(offered).toEqual([
    ["prompt-server", "m"],
    ["prompt-advisor", "a"],
    ["prompt-statusline", "s"],
  ]);
  for (const key of ["prompt-advisor", "prompt-server", "prompt-statusline"]) await ui.press({ key });
  expect(fills).toEqual(["/advisor fable", "/mcp", "/oh-my-claudeagent:omca-setup"]);
  await ui.unmount();
});
