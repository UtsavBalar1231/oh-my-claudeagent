import { spring } from "remotion";
import { color, mono, SAFE, springs, useMotion } from "../theme.ts";
import { CORNER_LABEL_HEIGHT } from "./CornerLabel.tsx";

/** source names the measurement behind the number, so the chip claims nothing beyond it. By default the chip sits below the CornerLabel, which holds the top-right corner on every footage beat; `at` moves its top-right corner. */
export type StatChipProps = { value: string; label: string; source: string; at?: { top: number; right: number } };

const SIZE = 32;

export const StatChip = ({ value, label, source, at = { top: SAFE.top + CORNER_LABEL_HEIGHT + 16, right: SAFE.x } }: StatChipProps) => {
  const { frame, fps, leave } = useMotion();
  const pop = spring({ frame, fps, config: springs.snappy });
  const out = leave();
  return (
    <div
      style={{
        position: "absolute",
        right: at.right,
        top: at.top,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 8,
        padding: "16px 26px",
        borderRadius: 16,
        background: color.panel,
        border: `1px solid ${color.frameBorder}`,
        fontFamily: mono,
        lineHeight: 1.2,
        whiteSpace: "nowrap",
        transformOrigin: "100% 0",
        opacity: Math.min(1, pop) * (1 - out),
        scale: `${0.8 + 0.2 * pop}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.6em", fontSize: SIZE, color: color.text }}>
        <span style={{ color: color.accent, fontWeight: 600, fontSize: SIZE * 1.25 }}>{value}</span>
        <span>{label}</span>
      </div>
      <div style={{ fontSize: 28, color: color.muted }}>{source}</div>
    </div>
  );
};
