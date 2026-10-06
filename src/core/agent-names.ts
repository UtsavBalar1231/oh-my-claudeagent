/** Old name to current name. A skill's old name is the id its agent had, so both tables map one name to one name. */
export const RENAMES = Object.freeze({
  agents: Object.freeze({
    sisyphus: "orchestrator",
    prometheus: "planner",
    metis: "analyzer",
    momus: "reviewer",
    explore: "explorer",
    librarian: "researcher",
    oracle: "architect",
    hephaestus: "build-fixer",
    "multimodal-looker": "viewer",
  }),
  skills: Object.freeze({
    metis: "analyzer",
    momus: "reviewer",
    hephaestus: "build-fixer",
  }),
});
