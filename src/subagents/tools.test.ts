// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import { deliveryBlueprintFixture } from "../engine/lifecycle-blueprint.test-support.js";
import type { SubagentCoordinator } from "./coordinator.js";
import { workflowMcpSubagentTools } from "./tools.js";

describe("subagent MCP tool contributors", () => {
  it("matches every subagent tool name declared by the lifecycle blueprints", async () => {
    const contributors = workflowMcpSubagentTools({} as SubagentCoordinator);
    const declared = new Set<string>();
    for (const kind of ["standard-delivery", "trivial"] as const) {
      const blueprint = deliveryBlueprintFixture(kind);
      for (const tool of blueprint.nodes.flatMap(({ tools }) => tools ?? [])) {
        if (tool === "spawn" || tool === "liveness") declared.add(tool);
      }
    }

    expect(contributors.map(({ name }) => name).sort()).toEqual(
      [...declared].sort(),
    );
    expect([...declared].sort()).toEqual(["liveness", "spawn"]);

    const registered: string[] = [];
    const server = {
      registerTool(name: string) {
        registered.push(name);
      },
    };
    for (const contributor of contributors) {
      contributor.register(server as never, {} as never);
    }
    expect(registered.sort()).toEqual(["liveness", "spawn"]);
  });
});
