// ---
// relationships:
//   verifies: node-types
// ---
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, expect, it } from "vitest";
import { GitHubBindingService } from "../src/binding/service.js";
import { GITHUB_OPERATIONS } from "../src/binding/operations.js";
import {
  NODE_TYPE_REGISTRY,
  type NodeTypeContract,
} from "../src/blueprints/node-types.js";
import { BUILT_IN_NODE_TYPES } from "../src/engine/node-capabilities.js";
import { RunStore } from "../src/engine/store.js";
import type { EngineNode } from "../src/engine/types.js";
import { serviceNodes } from "../src/service/nodes.js";

const dirs: string[] = [];
const stores: RunStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const stub: EngineNode = () => Promise.resolve();

/** The node types the real composition dispatches, read from that composition. */
function dispatchable(): Set<string> {
  const dir = mkdtempSync(join(tmpdir(), "availability-"));
  dirs.push(dir);
  const store = new RunStore(join(dir, "state.db"));
  stores.push(store);
  const binding = new GitHubBindingService(
    store,
    [],
    () => {
      throw new Error("The agreement check never reaches GitHub");
    },
    () => Promise.resolve([]),
    {
      nodes: serviceNodes(stub, stub),
      resolveBlueprint: () => {
        throw new Error("The agreement check never resolves a blueprint");
      },
    },
    { notifications: { send: () => Promise.resolve() } },
  );
  return new Set([
    ...BUILT_IN_NODE_TYPES,
    ...Object.keys(binding.runtimeNodes),
  ]);
}

const contracts = Object.entries(NODE_TYPE_REGISTRY) as [
  string,
  NodeTypeContract,
][];

it.each(contracts)(
  "marks %s available exactly when the composition dispatches it",
  (name, contract) => {
    expect(dispatchable().has(name)).toBe(contract.available);
  },
);

it("catalogs every node type the composition dispatches", () => {
  for (const name of dispatchable())
    expect(Object.keys(NODE_TYPE_REGISTRY)).toContain(name);
});

it("marks a github operation available exactly when an implementation exists", () => {
  const contract: NodeTypeContract = NODE_TYPE_REGISTRY.github;
  const operations = contract.operations ?? {};
  const implemented = new Set(Object.keys(GITHUB_OPERATIONS));

  for (const [operation, available] of Object.entries(operations))
    expect(implemented.has(operation)).toBe(available);
  for (const operation of implemented)
    expect(Object.keys(operations)).toContain(operation);
});

it("marks availability for every operation the blueprint schema publishes", () => {
  const schema = parse(
    readFileSync("docs/specifications/blueprint.schema.yml", "utf8"),
  ) as {
    $defs: { githubParams: { properties: { operation: { enum: string[] } } } };
  };
  const contract: NodeTypeContract = NODE_TYPE_REGISTRY.github;

  expect(Object.keys(contract.operations ?? {}).sort()).toEqual(
    [...schema.$defs.githubParams.properties.operation.enum].sort(),
  );
});
