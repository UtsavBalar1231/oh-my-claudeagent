import { assertWords, color, mono, SAFE, useMotion } from "../theme.ts";

const FADE = 0.25;

export const Caption = ({ text }: { text: string }) => {
  const { enter, leave } = useMotion();
  assertWords(text);
  return (
    <div
      style={{
        position: "absolute",
        left: SAFE.x,
        right: SAFE.x,
        bottom: SAFE.bottom + 16,
        textAlign: "center",
        fontFamily: mono,
        fontSize: 30,
        lineHeight: 1.2,
        color: color.caption,
        opacity: enter(0, FADE) * (1 - leave(FADE)),
      }}
    >
      {text}
    </div>
  );
};
