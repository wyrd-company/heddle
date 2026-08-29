// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import { validateBlueprint } from "./blueprint.js";
import type { LifecycleBlueprint } from "./types.js";

const blueprint = (): LifecycleBlueprint => ({
  edges: [
    {
      condition: "result.output.dispositions.complete",
      description: "Complete the stage",
      disposition: "complete",
      source: "prepare",
      target: "finish",
    },
  ],
  nodes: [
    {
      handoff: "standard",
      id: "prepare",
      tools: ["advance"],
      "todo-template": "sample-prepare",
      uses: "wait",
    },
    { id: "finish", uses: "finish" },
  ],
});

const validate = (value: LifecycleBlueprint): void =>
  validateBlueprint(value, { finish: async () => null });

describe("lifecycle blueprint handoff metadata", () => {
  it("rejects an agent wait with missing handoff metadata", () => {
    const value = blueprint();
    delete value.nodes[0]!.handoff;

    expect(() => validate(value)).toThrow(
      'Agent wait node "prepare" has no handoff metadata',
    );
  });

  it("rejects invalid handoff metadata", () => {
    const value = blueprint();
    value.nodes[0]!.handoff = "private" as "standard";

    expect(() => validate(value)).toThrow(
      'Node "prepare" has invalid handoff metadata',
    );
  });

  it("rejects handoff metadata on a non-wait node", () => {
    const value = blueprint();
    value.nodes[1]!.handoff = "standard";

    expect(() => validate(value)).toThrow(
      'Non-wait node "finish" must not declare handoff metadata',
    );
  });
});
