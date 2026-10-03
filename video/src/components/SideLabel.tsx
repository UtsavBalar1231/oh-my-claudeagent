import { color, mono, SAFE, useMotion } from "../theme.ts";

// The before-and-after label, top left outside the window. `enters` and `leaves` fade it after the
// opening crossfade or before the closing one, where the neighbouring beat shows another label.
export type SideLabelProps = { text: string; tone: "plain" | "omca"; enters?: boolean; leaves?: boolean };

export const SideLabel = ({ text, tone, enters = false, leaves = false }: SideLabelProps) => {
  const { enter, leave } = useMotion();
  return (
    <div
      style={{
        position: "absolute",
        left: SAFE.x,
        top: SAFE.top,
        fontFamily: mono,
        fontSize: 32,
        fontWeight: 600,
        lineHeight: 1,
        letterSpacing: "0.1em",
        whiteSpace: "nowrap",
        color: tone === "omca" ? color.accent : color.muted,
        opacity: (enters ? enter() : 1) * (1 - (leaves ? leave() : 0)),
      }}
    >
      {text.toUpperCase()}
    </div>
  );
};
