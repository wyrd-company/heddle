// ---
// relationships:
//   verifies: node-types
// ---
import { preparePass } from "../src/pass/prepare.js";
import { expect, it } from "vitest";
import { blueprint, passFixture } from "./support/pass-fixture.js";

it.each([
  ["prompt", 12, "pinned template path"],
  ["runtimeMode", "unknown", "Invalid pass runtime mode"],
  ["worktree", "", "requires a worktree"],
  ["resumeThread", "missing", "does not identify a prior thread"],
  ["tools", {}, "must be a list"],
  [
    "tools",
    [{ name: 1, endpoint: "https://tools.example.test" }],
    "name and endpoint",
  ],
  [
    "tools",
    [{ name: "heddle", endpoint: "https://tools.example.test" }],
    "belongs to the generated",
  ],
  [
    "tools",
    [
      { name: "catalog", endpoint: "https://tools.example.test" },
      { name: "catalog", endpoint: "https://tools.example.test/other" },
    ],
    "must be unique",
  ],
  ["turnEndPolicy", "unknown", "Invalid pass turn-end policy"],
  ["escalation", "unknown", "Invalid pass escalation mode"],
  ["prompt", { inline: "Inspect {{ missing }}" }, "undefined"],
] as const)(
  "rejects invalid %s input %j before T3 effects",
  async (key, value, message) => {
    const plan = structuredClone(blueprint);
    const node = plan.nodes[0];
    if (!node) throw new Error("missing node");
    node.params = { ...node.params, [key]: value };
    const f = passFixture(plan);
    await f.engine.start({
      id: "run",
      blueprintId: "inspection",
      commit: "pinned",
      context: { item: "parcel" },
    });
    expect(f.store.get("run").status).toBe("failed");
    await expect(
      preparePass(
        {
          run: f.store.get("run"),
          nodeId: "inspect",
          visit: 1,
          effectKey: "sample",
          params: node.params ?? {},
          input: null,
          context: { item: "parcel" },
          await: () => Promise.resolve(),
        },
        f.options,
      ),
    ).rejects.toThrow(message);
    expect(f.client.projects.ensure).not.toHaveBeenCalled();
    expect(f.commands).toEqual([]);
  },
);
