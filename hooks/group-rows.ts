import type { ImageSource, RenderElement, ToolGroupCall } from "claude-code";
import { isHookDisabled } from "../src/core/kill-switch.ts";
import { isAbsolutePath, joinPath, type Platform } from "../src/core/path.ts";
import { type ImagePreview, imagePreview, previewBox, previewCaption, previewName } from "../src/core/preview.ts";
import { glyphTestLine, glyphTestRow, receiptRow, shellReceipt } from "../src/core/receipt.ts";
import { type Refusal, refusalOf } from "../src/core/refusals.ts";
import { field, inputText } from "../src/core/tool-input.ts";
import { fitEnd, type Glyphs, glyphs } from "../src/core/ui-kit.ts";
import { fitPieces, type Piece, piecesWidth, TONE_KEYS } from "../src/core/visual.ts";
import { blockerLines, COMPLETION_KINDS } from "./blocker-rows.ts";
import type { Features, Input } from "./dispatch.ts";
import { type Host, reason, resolvedSession } from "./host.ts";
import { isRemote, type Kit, kitOf, Line } from "./ui.ts";

// A cell kept free at the row's end, as the transcript's other OMCA rows keep it.
const GUTTER = 1;
const MAX_PREVIEWS = 3;
// The terminal draws at most 2 MiB of picture bytes in one tree; a picture past that is named by its path.
const MAX_TREE_BYTES = 2 * 1024 * 1024;
const PREVIEW_INDENT = 5;
// Long enough for the terminal to have drawn the first preview, or its alt, before the probe asks which.
const PROBE_MS = 300;

type Kind = "png" | "file";

const kindOf = (source: ImageSource): Kind => ("file" in source ? "file" : "png");

// Whether the terminal draws each kind of source, unknown until the first preview of that kind is
// probed. A kind drawn only as the alt gets the caption alone from then on: tmux and iTerm2 draw
// bytes but not a file, and tmux draws neither until its passthrough is on.
const pictures: Partial<Record<Kind, boolean>> = {};
const probing = new Set<Kind>();
let isPassthroughNoted = false;

async function absoluteOf(host: Host, path: string): Promise<string> {
  const { platform } = resolvedSession();
  return isAbsolutePath(platform, path) ? path : joinPath(platform, await host.session.cwd(), path);
}

async function fileOf(host: Host, path: string): Promise<ImageSource | undefined> {
  if (path === "") return undefined;
  return { file: await absoluteOf(host, path), format: "png" };
}

// The detached `sh -c` returns at once, so a viewer that stays in the foreground never holds the press.
// explorer.exe exits 1 even when it opens the file, so on win32 only a rejection is a failure.
const openerOf = (platform: Platform, path: string): string[] =>
  platform === "win32" ? ["explorer.exe", path] : platform === "darwin" ? ["open", path] : ["sh", "-c", 'xdg-open "$1" >/dev/null 2>&1 &', "omca-open", path];

async function openImage(host: Host, path: string): Promise<void> {
  const name = previewName(path);
  try {
    const target = await absoluteOf(host, path);
    if (!(await host.fs.exists(target))) {
      host.ui.toast(`${name} is no longer there`);
      return;
    }
    const { platform } = resolvedSession();
    const { exitCode, stderr } = await host.process.run(openerOf(platform, target));
    if (exitCode !== 0 && platform !== "win32") host.ui.toast(`Cannot open ${name}: ${stderr.trim() || `the viewer exited ${exitCode}`}`);
  } catch (error) {
    host.ui.toast(`Cannot open ${name}: ${reason(error)}`);
  }
}

// The previews share one tree's byte budget, the first first; one that no longer fits goes by its path.
async function sourcesOf(host: Host, previews: readonly ImagePreview[]): Promise<(ImageSource | undefined)[]> {
  let room = MAX_TREE_BYTES;
  const sources: (ImageSource | undefined)[] = [];
  for (const { base64, path } of previews.slice(0, MAX_PREVIEWS)) {
    const bytes = (base64.length * 3) / 4;
    if (base64 === "") sources.push(undefined);
    else if (bytes <= room) {
      room -= bytes;
      sources.push({ png: base64 });
    } else sources.push(await fileOf(host, path));
  }
  return sources;
}

function probe(host: Host, requestId: string, key: string, source: ImageSource): void {
  const kind = kindOf(source);
  if (pictures[kind] !== undefined || probing.has(kind)) return;
  probing.add(kind);
  host.clock.after(PROBE_MS, async () => {
    try {
      const { deny, fix } = await host.ui.blit({ requestId, key, source });
      const isDrawn = deny === undefined || !/\balt\b/.test(deny);
      pictures[kind] = isDrawn;
      if (!isDrawn) host.ui.invalidate();
      if (fix === "tmux-passthrough" && !isPassthroughNoted) {
        isPassthroughNoted = true;
        host.ui.say("OMCA's picture previews are held back by tmux. Turn on tmux's allow-passthrough and focus-events, then start a new session to see them.");
      }
    } catch (error) {
      host.log(`group rows: cannot tell whether the terminal draws pictures: ${reason(error)}`);
    } finally {
      probing.delete(kind);
    }
  });
}

async function previewRows(host: Host, kit: Kit, e: Input<"ui.render ToolGroup">, columns: number): Promise<RenderElement[]> {
  const previews = e.props.calls.flatMap((call) => {
    const preview = imagePreview(call);
    return preview === null ? [] : [preview];
  });
  if (previews.length === 0) return [];
  const g = glyphs(resolvedSession().glyphTier);
  const sources = await sourcesOf(host, previews);
  // Past the first few, a read keeps its caption alone, so a burst of screenshots stays a list.
  return previews.flatMap((preview, index) => {
    const isLink = preview.path !== "";
    const text = Line(kit, previewCaption(preview, g, columns, isLink));
    const caption = isLink ? kit.Button({ key: `preview-open-${index}`, plain: true, onPress: () => openImage(host, preview.path), children: [text] }) : text;
    const source = sources[index];
    if (kit.Image === undefined || source === undefined || pictures[kindOf(source)] === false) return [caption];
    const key = `preview-${index}`;
    const box = previewBox(preview, columns - PREVIEW_INDENT);
    probe(host, e.requestId, key, source);
    const picture = kit.Image({ key, source, columns: box.columns, rows: box.rows, alt: preview.path || " " });
    return [caption, kit.Box({ key: `preview-box-${index}`, paddingLeft: PREVIEW_INDENT, children: [picture] })];
  });
}

function guardRefusalOf(call: ToolGroupCall): Refusal | undefined {
  if (!call.isErrored || typeof call.output !== "string") return undefined;
  const refusal = refusalOf(call.output);
  return refusal?.kind === "guard" || refusal?.kind === "review-refused" ? refusal : undefined;
}

// The header the engine draws over a standalone call: its tool and the command's first line.
function headerOf(call: ToolGroupCall, g: Glyphs, columns: number): Piece[] {
  const head: Piece[] = [{ text: g.running, color: TONE_KEYS.fail }, { text: " " }, { text: call.tool, bold: true }];
  const command = inputText(call.input, "command").split("\n")[0] ?? "";
  if (command === "") return fitPieces(head, columns, g.ellipsis);
  const shown = fitEnd(command, columns - piecesWidth(head) - 2, g.ellipsis);
  return fitPieces([...head, { text: `(${shown})` }], columns, g.ellipsis);
}

function heldLines(call: ToolGroupCall, g: Glyphs, columns: number): Piece[][] {
  const error = field(call.output, "error");
  if (call.tool !== "TaskUpdate" || call.isErrored || field(call.output, "success") !== false || typeof error !== "string") return [];
  const refusal = refusalOf(error);
  if (refusal === undefined || !(COMPLETION_KINDS.has(refusal.kind) || refusal.kind === "ledger-invalid")) return [];
  const taskId = refusal.taskId ?? (inputText(call.input, "taskId") || undefined);
  return blockerLines(refusal, taskId, g, columns) ?? [];
}

// A folded group of nothing but OMCA's guard refusals draws each call as its header and OMCA's rows,
// where the engine draws a count and the reason cut at two lines. A refused call never ran, so it has
// no receipt, glyph test or preview to keep. A hook-timing row in such a group shows under ctrl+o only.
//
// Below a folded tool group: one row per verification run in it, read from the run's own output,
// the line a glyph test printed, so the user's font draws it where the folded group hides it,
// and a preview of each PNG a Read call returned, so the row never waits on a file or a state
// write, and a row for each completion OMCA held, which the engine draws nothing for. An unfolded
// group draws each call itself, and a group with none of these is left as drawn.
export const groupRows: Features = {
  "ui.render ToolGroup": {
    pre(host, e) {
      const { calls, isExpanded } = e.props;
      if (isExpanded !== false || calls.length === 0) return undefined;
      const { glyphTier, disabledHooks } = resolvedSession();
      if (isHookDisabled(disabledHooks, "blocker-rows")) return undefined;
      const kit = kitOf(host.ui.resolve(e), e.surface);
      if (isRemote(kit)) return undefined;
      const refused = calls.flatMap((call) => {
        const refusal = guardRefusalOf(call);
        return refusal === undefined ? [] : [{ call, refusal }];
      });
      if (refused.length !== calls.length) return undefined;
      const g = glyphs(glyphTier);
      const columns = (e.viewport?.columns ?? 80) - GUTTER;
      const rows = refused.flatMap(({ call, refusal }) => [headerOf(call, g, columns), ...(blockerLines(refusal, undefined, g, columns) ?? [])]);
      return { answer: kit.Box({ key: "omca-group-refusals", flexDirection: "column", marginTop: 1, children: rows.map((pieces) => Line(kit, pieces)) }) };
    },
    async post(host, e, result) {
      if (e.surface !== "terminal" || e.props.isExpanded) return undefined;
      const { glyphTier, disabledHooks } = resolvedSession();
      const g = glyphs(glyphTier);
      const kit = kitOf(host.ui.resolve(e), e.surface);
      const columns = (e.viewport?.columns ?? 80) - GUTTER;
      const receipts = e.props.calls.flatMap((call) => {
        const receipt = shellReceipt(call);
        return receipt === null ? [] : [Line(kit, receiptRow(receipt, g, columns))];
      });
      const glyphTests = e.props.calls.flatMap((call) => {
        const line = glyphTestLine(call);
        return line === null ? [] : [Line(kit, glyphTestRow(line, g, columns))];
      });
      const previews = await previewRows(host, kit, e, columns);
      const held = isHookDisabled(disabledHooks, "blocker-rows") ? [] : e.props.calls.flatMap((call) => heldLines(call, g, columns).map((pieces) => Line(kit, pieces)));
      if (receipts.length === 0 && glyphTests.length === 0 && previews.length === 0 && held.length === 0) return undefined;
      return kit.Box({ key: "omca-group-rows", flexDirection: "column", children: [result, ...receipts, ...glyphTests, ...previews, ...held] });
    },
  },
};
