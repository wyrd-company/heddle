// ---
// relationships:
//   verifies: heddle
// ---

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cwd } from "node:process";

import { describe, expect, it } from "vitest";

import type { SubagentCoordinator } from "./coordinator.js";
import { workflowMcpSubagentTools } from "./tools.js";

describe("subagent MCP tool contributors", () => {
  it("matches every subagent tool name declared by the lifecycle blueprints", async () => {
    const contributors = workflowMcpSubagentTools({} as SubagentCoordinator);
    const declared = new Set<string>();
    for (const artifact of ["standard-delivery.json", "trivial.json"]) {
      const blueprint = JSON.parse(
        await readFile(join(cwd(), "blueprints", artifact), "utf8"),
      ) as { nodes: Array<{ tools?: string[] }> };
      for (const tool of blueprint.nodes.flatMap(({ tools }) => tools ?? [])) {
        if (tool === "spawn" || tool === "liveness") declared.add(tool);
      }
    }

    expect(contributors.map(({ name }) => name).sort()).toEqual(
      [...declared].sort(),
    );
    expect([...declared].sort()).toEqual(["liveness", "spawn"]);
  });
});
