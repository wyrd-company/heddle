// ---
// relationships:
//   verifies: blueprint-authoring
// ---
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const generated = [
  "docs/reference/blueprint-author-reference.md",
  "skills/blueprint-authoring/SKILL.md",
  "skills/blueprint-authoring/references/blueprint-author-reference.md",
  "src/generated/blueprint-authoring.ts",
];

describe("generated blueprint authoring surfaces", () => {
  it("matches the current registries and schema", () => {
    const root = mkdtempSync(join(tmpdir(), "heddle-authoring-"));
    try {
      execFileSync(process.execPath, ["scripts/generate-authoring.mjs", root]);
      for (const path of generated)
        expect(readFileSync(join(root, path), "utf8")).toBe(
          readFileSync(resolve(path), "utf8"),
        );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
