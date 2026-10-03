import type { Rect } from "../footage.ts";
import { assertWords, color, mono, SAFE, time, useMotion } from "../theme.ts";
import { useCameraTransform } from "./Camera.tsx";

const OUTSET = 10;
const RADIUS = 10;
const STROKE = 2;
const DIM = 0.55;
const LABEL_GAP = 14;
const LABEL_HEIGHT = 56;
const DRAW_DELAY = 0.067;

export type CalloutProps = { target: Rect; label: string };

// target is in footage pixels; the mask and box are drawn in composition space, so the stroke
// stays 2 px at any zoom. Place one Callout at a time inside a <Camera>.
export const Callout = ({ target, label }: CalloutProps) => {
  const { width, height, enter, leave } = useMotion();
  assertWords(label, 4);
  const rect = useCameraTransform()(target);
  const out = 1 - leave();
  const dim = enter(0, time.dim) * out;
  const draw = enter(DRAW_DELAY, time.draw);
  const tag = enter(DRAW_DELAY + time.draw * 0.7) * out;
  const box = { x: rect.x - OUTSET, y: rect.y - OUTSET, width: rect.width + 2 * OUTSET, height: rect.height + 2 * OUTSET };
  const below = box.y - LABEL_GAP - LABEL_HEIGHT < SAFE.top;
  const rightHalf = box.x + box.width / 2 > width / 2;
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          left: box.x,
          top: box.y,
          width: box.width,
          height: box.height,
          borderRadius: RADIUS,
          boxShadow: `0 0 0 ${width + height}px rgba(0, 0, 0, ${DIM * dim})`,
        }}
      />
      <svg
        width={box.width + STROKE}
        height={box.height + STROKE}
        style={{ position: "absolute", left: box.x - STROKE / 2, top: box.y - STROKE / 2, opacity: out, overflow: "visible" }}
      >
        <rect
          x={STROKE / 2}
          y={STROKE / 2}
          width={box.width}
          height={box.height}
          rx={RADIUS}
          fill="none"
          stroke={color.accent}
          strokeWidth={STROKE}
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - draw}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          top: below ? box.y + box.height + LABEL_GAP : box.y - LABEL_GAP - LABEL_HEIGHT,
          ...(rightHalf ? { right: Math.max(SAFE.x, width - (box.x + box.width)) } : { left: Math.max(SAFE.x, box.x) }),
          height: LABEL_HEIGHT,
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          borderRadius: 8,
          background: color.accent,
          color: color.canvas,
          fontFamily: mono,
          fontWeight: 600,
          fontSize: 30,
          whiteSpace: "nowrap",
          opacity: tag,
          translate: `0 ${(1 - tag) * (below ? -8 : 8)}px`,
        }}
      >
        {label}
      </div>
    </div>
  );
};
