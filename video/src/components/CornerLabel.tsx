import { color, mono, SAFE } from "../theme.ts";

export const CORNER_LABEL_HEIGHT = 30;

// A quiet disclosure on every footage beat, so it sits below the 28 px floor for overlay content.
// It does not animate: it is present from frame 0 and leaves with its beat's transition.
export const CornerLabel = () => (
  <div
    style={{
      position: "absolute",
      right: SAFE.x,
      top: SAFE.top,
      height: CORNER_LABEL_HEIGHT,
      fontFamily: mono,
      fontSize: 23,
      lineHeight: `${CORNER_LABEL_HEIGHT}px`,
      color: color.quiet,
      textShadow: "0 1px 8px rgba(0, 0, 0, 0.9)",
      whiteSpace: "nowrap",
    }}
  >
    Real Claude Code · scripted session
  </div>
);
