import type { CSSProperties } from "react";
import type { Rect } from "../footage.ts";
import { assertWords, color, mono, SAFE, time, useMotion } from "../theme.ts";
import { useCameraArea, useCameraTransform } from "./Camera.tsx";

const OUTSET = 10;
const RADIUS = 10;
const STROKE = 2;
const DIM = 0.55;
const LABEL_GAP = 14;
const LABEL_HEIGHT = 46;
const DRAW_DELAY = 0.067;

/** Where the label sits: beside the box, or a bar centered across the frame at `bottom` or `top` px from its edge. Pick the side that lands on empty footage, never on text. */
export type LabelSide = "above" | "below" | "left" | "right" | { bottom: number } | { top: number };

/** `outset` is the gap between the target and the box, in composition pixels. */
export type CalloutProps = { target: Rect; label: string; side?: LabelSide; outset?: { x: number; y: number } };

// The box is clipped to the camera's window, so a target running past the window edge is boxed
// where it is visible.
const clipTo = (rect: Rect, area: Rect, outset: { x: number; y: number }): Rect => {
  const x = Math.max(rect.x, area.x + outset.x + STROKE);
  const y = Math.max(rect.y, area.y + outset.y + STROKE);
  return {
    x,
    y,
    width: Math.min(rect.x + rect.width, area.x + area.width - outset.x - STROKE) - x,
    height: Math.min(rect.y + rect.height, area.y + area.height - outset.y - STROKE) - y,
  };
};

const labelPlacement = (side: LabelSide, box: Rect, width: number): CSSProperties => {
  const middle = box.y + box.height / 2 - LABEL_HEIGHT / 2;
  if (typeof side === "object") return { ...side, left: "50%", translate: "-50% 0" };
  if (side === "right") return { top: middle, left: box.x + box.width + LABEL_GAP };
  if (side === "left") return { top: middle, right: width - box.x + LABEL_GAP };
  const top = side === "below" ? box.y + box.height + LABEL_GAP : box.y - LABEL_GAP - LABEL_HEIGHT;
  return { top, ...(box.x + box.width / 2 > width / 2 ? { right: Math.max(SAFE.x, width - (box.x + box.width)) } : { left: Math.max(SAFE.x, box.x) }) };
};

// target is in footage pixels; the mask and box are drawn in composition space, so the stroke
// stays 2 px at any zoom. Place one Callout at a time inside a <Camera> or <CameraOverlay>.
export const Callout = ({ target, label, side, outset = { x: OUTSET, y: OUTSET } }: CalloutProps) => {
  const { width, height, enter, leave } = useMotion();
  assertWords(label, 4);
  const rect = clipTo(useCameraTransform()(target), useCameraArea(), outset);
  const out = 1 - leave();
  const dim = enter(0, time.dim) * out;
  const draw = enter(DRAW_DELAY, time.draw);
  const tag = enter(DRAW_DELAY + time.draw * 0.7) * out;
  const box = { x: rect.x - outset.x, y: rect.y - outset.y, width: rect.width + 2 * outset.x, height: rect.height + 2 * outset.y };
  const placed = side ?? (box.y - LABEL_GAP - LABEL_HEIGHT < SAFE.top ? "below" : "above");
  const rise = placed === "below" ? -8 : 8;
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
          ...labelPlacement(placed, box, width),
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
          transform: `translateY(${(1 - tag) * rise}px)`,
        }}
      >
        {label}
      </div>
    </div>
  );
};
