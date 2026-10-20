import { receiptRow, shellReceipt } from "../src/core/receipt.ts";
import { glyphs } from "../src/core/ui-kit.ts";
import type { Features } from "./dispatch.ts";
import { resolvedSession } from "./host.ts";
import { kitOf, Line } from "./ui.ts";

// A cell kept free at the row's end, as the transcript's other OMCA rows keep it.
const GUTTER = 1;

// Below a folded shell group, one row per verification call in it: what it returned, read from the
// call's own output, so the row never waits on a file or a state write. An unfolded group draws
// each call's output itself, and a group with no verification call is left as drawn.
export const receipts: Features = {
  "ui.render ToolGroup": {
    post(host, e, result) {
      if (e.surface !== "terminal" || e.props.isExpanded) return undefined;
      const found = e.props.calls.flatMap((call) => {
        const receipt = shellReceipt(call);
        return receipt === null ? [] : [receipt];
      });
      if (found.length === 0) return undefined;
      const g = glyphs(resolvedSession().glyphTier);
      const kit = kitOf(host.ui.resolve(e), e.surface);
      const columns = (e.viewport?.columns ?? 80) - GUTTER;
      return kit.Box({
        key: "omca-receipts",
        flexDirection: "column",
        children: [result, ...found.map((receipt) => Line(kit, receiptRow(receipt, g, columns)))],
      });
    },
  },
};
