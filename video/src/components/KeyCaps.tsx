import { Fragment } from "react";
import { interpolateColors, spring } from "remotion";
import { color, mono, SAFE, springs, time, useMotion } from "../theme.ts";

const TRAVEL = 6;
const SIZE = 56;
// Seconds from the start of the enclosing Sequence; start the Sequence this long before the key event.
export const KEY_PRESS_AT = 0.3;

export type KeyCapsProps = { keys: readonly string[] };

export const KeyCaps = ({ keys }: KeyCapsProps) => {
  const { frame, fps, f, leave } = useMotion();
  const appear = spring({ frame, fps, config: springs.snappy });
  const down = f(KEY_PRESS_AT);
  const up = down + f(time.keyHold);
  const pressed = spring({ frame: frame - down, fps, config: springs.snappy }) - spring({ frame: frame - up, fps, config: springs.snappy });
  const out = leave();
  return (
    <div
      style={{
        position: "absolute",
        left: SAFE.x,
        right: SAFE.x,
        bottom: SAFE.bottom + 24,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: 20,
        fontFamily: mono,
        fontWeight: 600,
        fontSize: SIZE,
        lineHeight: 1,
        opacity: Math.min(1, appear) * (1 - out),
        scale: `${0.85 + 0.15 * appear}`,
      }}
    >
      {keys.map((key, i) => (
        <Fragment key={key}>
          {i === 0 ? null : <span style={{ color: color.muted }}>+</span>}
          <span
            style={{
              minWidth: SIZE * 1.5,
              height: SIZE * 1.7,
              padding: "0 0.45em",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 14,
              background: color.keyFace,
              border: `2px solid ${interpolateColors(pressed, [0, 1], [color.keyEdge, color.accent])}`,
              boxShadow: `0 ${TRAVEL * (1 - pressed)}px 0 #000`,
              translate: `0 ${TRAVEL * pressed}px`,
              color: color.text,
            }}
          >
            {key}
          </span>
        </Fragment>
      ))}
    </div>
  );
};
