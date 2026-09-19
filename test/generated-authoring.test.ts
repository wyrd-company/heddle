// ---
// relationships:
//   verifies: blueprint-authoring
// ---
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NODE_TYPE_REGISTRY, VALIDATION_RULES } from "../src/index.js";
import pluginContracts from "../src/agent-tools/plugin-contracts.json" with { type: "json" };

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

  it("covers every registered contract and the sequential dispatch agreement", () => {
    const reference = readFileSync(
      "docs/reference/blueprint-author-reference.md",
      "utf8",
    );
    for (const name of Object.keys(NODE_TYPE_REGISTRY))
      expect(reference).toContain(`### \`${name}\``);
    for (const rule of VALIDATION_RULES)
      expect(reference).toContain(`\`${rule.name}\`: ${rule.description}`);
    for (const files of Object.values(pluginContracts))
      for (const file of files) expect(reference).toContain(`\`${file}\``);
    expect(reference).toContain("engine concurrency 1");
    expect(readFileSync("src/engine/engine.ts", "utf8")).toContain(
      "{ concurrency: 1 }",
    );
    expect(
      readFileSync("docs/technical-designs/engine-and-run-model.yml", "utf8"),
    ).toContain("concurrency 1");
  });
});
