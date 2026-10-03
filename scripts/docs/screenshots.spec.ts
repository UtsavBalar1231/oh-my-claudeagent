import { describe, expect, test } from "bun:test";
import { SHOTS } from "./screenshots.ts";

describe("SHOTS", () => {
  test("names are unique file stems and every shot fits a real terminal", () => {
    const names = SHOTS.map((shot) => shot.name);
    expect(new Set(names).size).toBe(names.length);
    for (const shot of SHOTS) {
      expect(shot.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(shot.cols).toBeGreaterThanOrEqual(80);
      expect(shot.rows).toBeGreaterThanOrEqual(20);
    }
  });

  test("captures every README scene as a still and the two clips as GIFs", () => {
    expect(SHOTS.filter((shot) => shot.format === "png").map((shot) => shot.name)).toEqual(["hero", "band", "plan", "guard", "doctor", "statusline"]);
    expect(SHOTS.filter((shot) => shot.format === "gif").map((shot) => shot.name)).toEqual(["pane-tour", "guard-dialog"]);
  });

  test("the plan scene is ready only once task 7 is open", () => {
    const plan = SHOTS.find((shot) => shot.name === "plan");
    expect(plan?.ready("[ ] 7. Wire the order summary panel\n- Depends: 6")).toBe(true);
    expect(plan?.ready("[ ] 7. Wire the order summary panel")).toBe(false);
  });

  test("the guard scenes are ready only once the dialog holds the command", () => {
    for (const name of ["guard", "guard-dialog"]) {
      const guard = SHOTS.find((shot) => shot.name === name);
      expect(guard?.ready("● Removing the build output\nOMCA held this command for your review:")).toBe(true);
      expect(guard?.ready("● Removing the build output")).toBe(false);
    }
  });
});
