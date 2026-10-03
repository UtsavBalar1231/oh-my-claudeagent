import { Fragment } from "react";
import { spring } from "remotion";
import { color, mono, SAFE, springs, time, useMotion } from "../theme.ts";

const ITEMS_AT = 0.1;

export type LowerThirdProps = { items: readonly string[] };

export const LowerThird = ({ items }: LowerThirdProps) => {
  const { frame, fps, enter, leave } = useMotion();
  const slide = spring({ frame, fps, config: springs.calm });
  const out = leave();
  return (
    <div
      style={{
        position: "absolute",
        left: SAFE.x,
        bottom: SAFE.bottom,
        display: "flex",
        alignItems: "center",
        gap: "0.7em",
        padding: "18px 28px",
        borderRadius: 12,
        background: color.panel,
        border: `1px solid ${color.frameBorder}`,
        borderLeft: `4px solid ${color.accent}`,
        fontFamily: mono,
        fontSize: 32,
        lineHeight: 1.2,
        color: color.text,
        whiteSpace: "nowrap",
        opacity: Math.min(1, slide) * (1 - out),
        translate: `${(1 - slide) * -40}px ${out * 12}px`,
      }}
    >
      {items.map((item, i) => {
        const shown = enter(ITEMS_AT + i * time.stagger * 2);
        return (
          <Fragment key={item}>
            {i === 0 ? null : <span style={{ color: color.accent, opacity: shown }}>·</span>}
            <span style={{ opacity: shown, translate: `0 ${(1 - shown) * 8}px` }}>{item}</span>
          </Fragment>
        );
      })}
    </div>
  );
};
