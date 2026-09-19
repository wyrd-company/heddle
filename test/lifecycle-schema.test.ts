// ---
// relationships:
//   verifies:
//     - blueprint-authoring
//     - node-types
// ---
import { expect, it } from "vitest";
import { NODE_TYPE_REGISTRY } from "../src/index.js";
import {
  validateBlueprintSchema,
  validateNodeParams,
} from "../src/blueprints/schema-validation.js";

it.each([
  { blueprint: "collection" },
  {
    blueprint: { from: "selection.blueprint" },
    inputs: { from: "selection.inputs" },
  },
  {
    blueprint: "collection",
    inputs: { settings: { from: "issue.fields" }, priority: 3 },
  },
])("publishes the lifecycle-start input contract %j", (params) => {
  expect(validateNodeParams("lifecycle-start", params).errors).toEqual([]);
  expect(
    validateBlueprintSchema({
      id: "selection",
      kind: "helper",
      nodes: { start: { uses: "lifecycle-start", params } },
    }).errors,
  ).toEqual([]);
});
it.each([
  undefined,
  {},
  { blueprint: "../collection" },
  { blueprint: { from: "" } },
  { blueprint: "collection", inputs: [] },
  { blueprint: "collection", inputs: { issue: { id: "item-2" } } },
  { blueprint: "collection", outputs: { answer: "result" } },
])("rejects invalid lifecycle-start authored input %j", (params) => {
  expect(
    validateNodeParams("lifecycle-start", params).errors.length,
  ).toBeGreaterThan(0);
  expect(
    validateBlueprintSchema({
      id: "selection",
      kind: "helper",
      nodes: {
        start: {
          uses: "lifecycle-start",
          ...(params === undefined ? {} : { params }),
        },
      },
    }).errors.length,
  ).toBeGreaterThan(0);
});

it("publishes the synchronous started result for blueprint author references", () => {
  expect(NODE_TYPE_REGISTRY["lifecycle-start"].pausing).toBe(false);
  expect(NODE_TYPE_REGISTRY["lifecycle-start"].results).toEqual(["started"]);
});
