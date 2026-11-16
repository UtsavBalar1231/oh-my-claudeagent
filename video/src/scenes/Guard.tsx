import { useVideoConfig } from "remotion";
import { Callout } from "../components/Callout.tsx";
import { Caption } from "../components/Caption.tsx";
import { CornerLabel } from "../components/CornerLabel.tsx";
import { SideLabel } from "../components/SideLabel.tsx";
import { StatChip } from "../components/StatChip.tsx";
import { mark, shownTarget, targetRect } from "../footage.ts";
import { color, SAFE, toFrames } from "../theme.ts";
import { F5 } from "./clips.ts";
import { RESET_BOX } from "./PlainReset.tsx";
import { aim, beatLength, Canvas, crossfadeFrames, fitWidth, labelSpan, marginCol, Shot, Timed, timeline, TOP_BAR } from "./shot.tsx";

const FIT = fitWidth(F5);
const REFUSED = mark(F5, "refused");
const KEPT = mark(F5, "kept");
const REFUSAL = shownTarget(F5, "refusal-row", KEPT);
// From the prompt, five rows above the refusal row, as the plain reset frames its twin.
const VIEW = aim(F5, RESET_BOX, { scale: FIT.scale, top: REFUSAL.row - 5, left: marginCol(F5) });
const LENGTH = beatLength(6.5);
const CHIP_AT = { top: RESET_BOX.y + RESET_BOX.height + 14, right: SAFE.x };

export const guardPlan = (fps: number) => {
  const f = (s: number) => toFrames(s, fps);
  const edge = crossfadeFrames(fps);
  const t = timeline(F5, fps);
  // The submitted prompt reaches the transcript a second after the command is typed; until then
  // the window is empty.
  t.play(mark(F5, "cmd-typed") + t.seconds(1), REFUSED, 3);
  const held = t.hold(REFUSED, 2.4);
  const reply = t.play(REFUSED, KEPT);
  t.fill(KEPT, LENGTH);
  // The caption and the stat chip share the band under the window, one after the other.
  return {
    t,
    callout: { from: held.start + f(0.1), duration: held.duration - f(0.2) },
    caption: { from: edge + f(0.1), duration: reply.start - edge - f(0.1) },
    chip: { from: reply.start + f(0.2), duration: t.duration - reply.start - f(0.2) - edge },
    duration: t.duration,
  };
};

export const Guard = () => {
  const { fps } = useVideoConfig();
  const plan = guardPlan(fps);
  return (
    <Canvas>
      <Shot clip={F5} border={color.omcaBorder} box={RESET_BOX} keyframes={[{ frame: 0, ...VIEW }]} segments={plan.t.segments}>
        <Timed {...plan.callout}>
          <Callout target={targetRect(F5, REFUSAL)} label="Refused, nothing lost" side={TOP_BAR} />
        </Timed>
      </Shot>
      <CornerLabel />
      <Timed {...labelSpan(plan.duration, fps, { enters: true, leaves: true })}>
        <SideLabel text="With OMCA · bypass" tone="omca" enters leaves />
      </Timed>
      <Timed {...plan.caption}>
        <Caption text="OMCA refuses it, even in bypass." />
      </Timed>
      <Timed {...plan.chip}>
        <StatChip
          value="Refused"
          label="with changes to lose; runs when clean"
          source="Measured 2026-11-17 · Claude Code 2.1.325 · under bypassPermissions"
          at={CHIP_AT}
        />
      </Timed>
    </Canvas>
  );
};
