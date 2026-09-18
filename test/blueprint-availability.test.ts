// ---
// relationships:
//   verifies:
//     - blueprint-authoring
//     - node-types
// ---
import { expect, it } from "vitest";
import { availabilityFindings } from "../src/blueprints/availability.js";
import { NODE_TYPE_REGISTRY } from "../src/blueprints/node-types.js";
import type { BlueprintNode } from "../src/blueprints/types.js";

const file = "/sample/sample-process.yml";

function findings(nodes: Record<string, BlueprintNode>) {
  return availabilityFindings(file, {
    id: "sample-process",
    kind: "helper",
    nodes,
  });
}

const unavailableTypes = Object.entries(NODE_TYPE_REGISTRY)
  .filter(([, contract]) => !contract.available)
  .map(([name]) => name);
const operations = NODE_TYPE_REGISTRY.github.operations;
const unavailableOperations = Object.entries(operations)
  .filter(([, available]) => !available)
  .map(([name]) => name);
const availableOperations = Object.entries(operations)
  .filter(([, available]) => available)
  .map(([name]) => name);

it("reports every node type with nothing behind it", () => {
  expect(unavailableTypes).toEqual(["question", "git"]);
  for (const uses of unavailableTypes)
    expect(findings({ step: { uses } })).toEqual([
      {
        file,
        node: "step",
        rule: "heddle.unavailable-node-type",
        message: `Node type is not available yet, because Heddle has no run-time implementation for it: ${uses}`,
      },
    ]);
});

it.each(unavailableOperations)(
  "reports the %s github operation",
  (operation) => {
    expect(
      findings({ step: { uses: "github", params: { operation } } }),
    ).toEqual([
      {
        file,
        node: "step",
        rule: "heddle.unavailable-operation",
        message: `github operation is not available yet, because Heddle has no run-time implementation for it: ${operation}`,
      },
    ]);
  },
);

it.each(availableOperations)("accepts the %s github operation", (operation) => {
  expect(findings({ step: { uses: "github", params: { operation } } })).toEqual(
    [],
  );
});

it("accepts every available node type and ignores an unknown one", () => {
  const nodes = Object.fromEntries(
    Object.entries(NODE_TYPE_REGISTRY)
      .filter(([, contract]) => contract.available)
      .map(([uses], index) => [`step-${String(index)}`, { uses }]),
  );

  expect(findings(nodes)).toEqual([]);
  expect(findings({ step: { uses: "not-a-node-type" } })).toEqual([]);
});
