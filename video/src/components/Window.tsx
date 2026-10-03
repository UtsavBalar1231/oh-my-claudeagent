import type { ReactNode } from "react";
import type { Rect } from "../footage.ts";
import { color } from "../theme.ts";

export const WINDOW_RADIUS = 14;

export type WindowProps = { box: Rect; children: ReactNode };

// The border is an overlay drawn above the footage so it does not shrink the footage area by 2 px.
export const Window = ({ box, children }: WindowProps) => (
  <div
    style={{
      position: "absolute",
      left: box.x,
      top: box.y,
      width: box.width,
      height: box.height,
      borderRadius: WINDOW_RADIUS,
      overflow: "hidden",
      background: "#000",
      boxShadow: "0 30px 80px rgba(0, 0, 0, 0.55), 0 8px 24px rgba(0, 0, 0, 0.35)",
    }}
  >
    {children}
    <div style={{ position: "absolute", inset: 0, borderRadius: WINDOW_RADIUS, border: `1px solid ${color.frameBorder}` }} />
  </div>
);
