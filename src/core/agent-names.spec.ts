import { expect, test } from "bun:test";
import { RENAMES } from "./agent-names.ts";

test("the table maps the nine renamed agents to their current names", () => {
  expect(RENAMES.agents).toEqual({
    sisyphus: "orchestrator",
    prometheus: "planner",
    metis: "analyzer",
    momus: "reviewer",
    explore: "explorer",
    librarian: "researcher",
    oracle: "architect",
    hephaestus: "build-fixer",
    "multimodal-looker": "viewer",
  });
});

test("the table maps the three renamed skills to the name their agent took", () => {
  expect(RENAMES.skills).toEqual({ metis: "analyzer", momus: "reviewer", hephaestus: "build-fixer" });
  for (const [old, current] of Object.entries(RENAMES.skills)) expect(RENAMES.agents[old as keyof typeof RENAMES.agents]).toBe(current);
});

test("every level of the table is frozen", () => {
  expect([RENAMES, RENAMES.agents, RENAMES.skills].map(Object.isFrozen)).toEqual([true, true, true]);
});

test("no current name is also an old name, so a rewrite never applies twice", () => {
  const olds = new Set(Object.keys(RENAMES.agents));
  expect(Object.values(RENAMES.agents).filter((current) => olds.has(current))).toEqual([]);
  expect(new Set(Object.values(RENAMES.agents)).size).toBe(Object.keys(RENAMES.agents).length);
});
