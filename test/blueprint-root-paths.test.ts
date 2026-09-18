// ---
// relationships:
//   verifies:
//     - blueprint-authoring
//     - engine-and-run-model
// ---
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { validateBlueprintPath } from "../src/index.js";
import { BlueprintCatalog } from "../src/service/blueprints.js";
import { commitFixture } from "./support/blueprint-repository.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

const edges = ["inspect", "measure"]
  .flatMap((node) =>
    ["handoff", "escalate", "timeout", "idle", "turnEnded", "overridden"].map(
      (result) =>
        `  - from: ${node}\n    to: ${node === "inspect" ? "measure" : "choose"}\n    when: result.output.${result}\n`,
    ),
  )
  .join("");

function blueprintSource(prefix: string): string {
  return `id: sample-process
kind: process
nodes:
  inspect:
    uses: pass
    params:
      prompt: { inline: Open the parcel. }
      handoff:
        type: object
        description: Submit the result.
        properties:
          accepted: { type: boolean }
        required: [accepted]
  measure:
    uses: pass
    params:
      prompt: ${prefix}parcel.njk
      handoff: ${prefix}receipt.yml
  choose:
    uses: policy
    params:
      rules: ${prefix}routing.yml
      input: { from: stages }
  finish:
    uses: terminal-result
    params:
      value: sample-result
edges:
${edges}  - from: choose
    to: finish
`;
}

/** A blueprint root holding one blueprint in a subdirectory beneath it. */
function nestedRoot(prefix = "catalog/"): string {
  const root = mkdtempSync(join(tmpdir(), "blueprint-root-"));
  roots.push(root);
  const directory = join(root, "catalog");
  mkdirSync(directory);
  writeFileSync(join(directory, "sample-process.yml"), blueprintSource(prefix));
  writeFileSync(join(directory, "parcel.njk"), "Inspect the parcel.\n");
  writeFileSync(
    join(directory, "receipt.yml"),
    "type: object\ndescription: Record the receipt.\nproperties:\n  accepted: { type: boolean }\nrequired: [accepted]\nadditionalProperties: false\n",
  );
  writeFileSync(
    join(directory, "routing.yml"),
    "rules:\n  - id: only\n    blueprint: sample-process\n    inputs: {}\n",
  );
  return root;
}

it("validates root-relative references from a blueprint in a subdirectory", () => {
  expect(validateBlueprintPath(nestedRoot())).toEqual([]);
});

it("reads root-relative artifacts at the pinned commit", async () => {
  const root = nestedRoot();
  const commit = commitFixture(root);
  const catalog = new BlueprintCatalog(root);

  expect(await catalog.read(commit, "catalog/parcel.njk")).toBe(
    "Inspect the parcel.\n",
  );
  expect(await catalog.read(commit, "catalog/receipt.yml")).toContain(
    "required: [accepted]",
  );
  expect(await catalog.read(commit, "catalog/routing.yml")).toContain(
    "id: only",
  );
});

it("reports a path spelled beside the blueprint file as missing", () => {
  expect(validateBlueprintPath(nestedRoot(""))).toContainEqual(
    expect.objectContaining({
      node: "measure",
      rule: "reference.exists",
      reference: "parcel.njk",
      message: "Referenced file does not exist (parcel.njk)",
    }),
  );
});

it("refuses a reference that escapes the blueprint root", () => {
  expect(validateBlueprintPath(nestedRoot("../"))).toContainEqual(
    expect.objectContaining({
      node: "measure",
      rule: "reference.exists",
      reference: "../parcel.njk",
      message:
        "Referenced file must stay inside the blueprint root (../parcel.njk)",
    }),
  );
});
