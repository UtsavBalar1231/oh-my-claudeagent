import type { ImageSource, RenderElement } from "claude-code";
import { isAbsolutePath, joinPath } from "../src/core/path.ts";
import { type ImagePreview, imagePreview, previewBox, previewCaption } from "../src/core/preview.ts";
import { receiptRow, shellReceipt } from "../src/core/receipt.ts";
import { glyphs } from "../src/core/ui-kit.ts";
import type { Features, Input } from "./dispatch.ts";
import { type Host, reason, resolvedSession } from "./host.ts";
import { type Kit, kitOf, Line } from "./ui.ts";

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

async function fileOf(host: Host, path: string): Promise<ImageSource | undefined> {
  if (path === "") return undefined;
  const { platform } = resolvedSession();
  return { file: isAbsolutePath(platform, path) ? path : joinPath(platform, await host.session.cwd(), path), format: "png" };
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
    const caption = Line(kit, previewCaption(preview, g, columns));
    const source = sources[index];
    if (kit.Image === undefined || source === undefined || pictures[kindOf(source)] === false) return [caption];
    const key = `preview-${index}`;
    const box = previewBox(preview, columns - PREVIEW_INDENT);
    probe(host, e.requestId, key, source);
    const picture = kit.Image({ key, source, columns: box.columns, rows: box.rows, alt: preview.path || " " });
    return [caption, kit.Box({ key: `preview-box-${index}`, paddingLeft: PREVIEW_INDENT, children: [picture] })];
  });
}

// Below a folded tool group: one row per verification run in it, read from the run's own output,
// and a preview of each PNG a Read call returned, so the row never waits on a file or a state
// write. An unfolded group draws each call itself, and a group with neither is left as drawn.
export const groupRows: Features = {
  "ui.render ToolGroup": {
    async post(host, e, result) {
      if (e.surface !== "terminal" || e.props.isExpanded) return undefined;
      const g = glyphs(resolvedSession().glyphTier);
      const kit = kitOf(host.ui.resolve(e), e.surface);
      const columns = (e.viewport?.columns ?? 80) - GUTTER;
      const receipts = e.props.calls.flatMap((call) => {
        const receipt = shellReceipt(call);
        return receipt === null ? [] : [Line(kit, receiptRow(receipt, g, columns))];
      });
      const previews = await previewRows(host, kit, e, columns);
      if (receipts.length === 0 && previews.length === 0) return undefined;
      return kit.Box({ key: "omca-group-rows", flexDirection: "column", children: [result, ...receipts, ...previews] });
    },
  },
};
