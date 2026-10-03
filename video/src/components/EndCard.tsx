import { AbsoluteFill } from "remotion";
import { color, mono, serif, useMotion } from "../theme.ts";
import { Typewriter, typingSeconds } from "./Typewriter.tsx";

const COMMANDS = ["claude plugin marketplace add UtsavBalar1231/oh-my-claudeagent", "claude plugin install oh-my-claudeagent@omca"] as const;
const REPO = "github.com/UtsavBalar1231/oh-my-claudeagent";
const FOOTER = "Free and open source · Claude Code 2.1.288+ · needs bun";
const FIRST_COMMAND_AT = 1;
const COMMAND_GAP = 0.33;
const COMMAND_SIZE = 42;
const SECOND_COMMAND_AT = FIRST_COMMAND_AT + typingSeconds(COMMANDS[0]) + COMMAND_GAP;
export const TYPED_AT = SECOND_COMMAND_AT + typingSeconds(COMMANDS[1]);

const rise = (p: number) => ({ opacity: p, translate: `0 ${(1 - p) * 8}px` });

export const EndCard = ({ line }: { line: string }) => {
  const { frame, f, enter } = useMotion();
  const lines = [
    { text: COMMANDS[0], at: FIRST_COMMAND_AT, cursor: frame < f(SECOND_COMMAND_AT) },
    { text: COMMANDS[1], at: SECOND_COMMAND_AT, cursor: frame >= f(SECOND_COMMAND_AT) },
  ];
  return (
    <AbsoluteFill style={{ background: color.canvas, alignItems: "center", justifyContent: "center", gap: 48 }}>
      <div style={{ fontFamily: serif, fontSize: 112, lineHeight: 1, color: color.text, ...rise(enter()) }}>{line}</div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: "26px 28px",
          borderRadius: 14,
          background: "#000",
          border: `1px solid ${color.frameBorder}`,
          ...rise(enter(FIRST_COMMAND_AT - COMMAND_GAP)),
        }}
      >
        {lines.map((line) => (
          <div
            key={line.text}
            style={{ fontFamily: mono, fontSize: COMMAND_SIZE, lineHeight: 1.3, whiteSpace: "pre", opacity: frame >= f(line.at - COMMAND_GAP) ? 1 : 0 }}
          >
            <span style={{ color: color.accent }}>$ </span>
            <Typewriter text={line.text} startAt={line.at} size={COMMAND_SIZE} cursor={line.cursor} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18, fontFamily: mono }}>
        <div style={{ fontSize: 36, letterSpacing: "0.02em", color: color.accent, ...rise(enter(TYPED_AT + 0.17)) }}>{REPO}</div>
        <div style={{ fontSize: 28, letterSpacing: "0.02em", color: color.muted, ...rise(enter(TYPED_AT + 0.27)) }}>{FOOTER}</div>
      </div>
    </AbsoluteFill>
  );
};
