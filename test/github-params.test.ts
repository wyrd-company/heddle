// ---
// relationships:
//   verifies: blueprint-authoring
// ---
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { validateBlueprintFile } from "../src/blueprints/validate.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function blueprintFile(params: string): string {
  const dir = mkdtempSync(join(tmpdir(), "github-params-"));
  dirs.push(dir);
  const file = join(dir, "sample-process.yml");
  writeFileSync(
    file,
    `id: sample-process\nkind: helper\nnodes:\n  apply:\n    uses: github\n    params:\n${params}`,
  );
  return file;
}

function paramFindings(params: string): string[] {
  return validateBlueprintFile(blueprintFile(params))
    .filter((item) => item.rule === "node.params")
    .map((item) => item.message);
}

it.each([
  [
    "a close reason outside the supported set",
    "      operation: close\n      reason: duplicate\n",
  ],
  ["remove-labels without labels", "      operation: remove-labels\n"],
  [
    "remove-labels with a non-string label",
    "      operation: remove-labels\n      labels: [1]\n",
  ],
  ["add-labels without labels", "      operation: add-labels\n"],
  ["comment without a body", "      operation: comment\n"],
  [
    "set-field without a value",
    "      operation: set-field\n      field: Notes\n",
  ],
  [
    "a set-field scope outside the supported set",
    "      operation: set-field\n      field: Notes\n      value: Ready\n      scope: repository\n",
  ],
])("rejects %s", (_name, params) => {
  expect(paramFindings(params)).not.toHaveLength(0);
});

it.each([
  ["close with no reason", "      operation: close\n"],
  ["close as completed", "      operation: close\n      reason: completed\n"],
  [
    "close as not planned",
    "      operation: close\n      reason: not-planned\n",
  ],
  ["reopen", "      operation: reopen\n"],
  [
    "remove-labels with labels",
    "      operation: remove-labels\n      labels: [seasonal]\n",
  ],
  [
    "add-labels with labels",
    "      operation: add-labels\n      labels: [seasonal]\n",
  ],
  ["comment with a body", "      operation: comment\n      body: Ready\n"],
  [
    "set-field with a value",
    "      operation: set-field\n      field: Notes\n      value: Ready\n",
  ],
])("accepts %s", (_name, params) => {
  expect(paramFindings(params)).toEqual([]);
});
