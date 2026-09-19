// ---
// relationships:
//   verifies: engine-and-run-model
// ---
import { expect, it } from "vitest";
import { supportsNodeType } from "../src/engine/node-capabilities.js";

it.each([
  "aggregate",
  "child-run",
  "lifecycle-start",
  "sleep",
  "terminal-result",
  "wait",
])("recognizes the built-in %s node type", (type) => {
  expect(supportsNodeType({}, type)).toBe(true);
});

it("recognizes a composed node and rejects an unavailable node", () => {
  const nodes = { sample: () => Promise.resolve() };

  expect(supportsNodeType(nodes, "sample")).toBe(true);
  expect(supportsNodeType(nodes, "absent")).toBe(false);
});
