// ---
// relationships:
//   verifies: heddle
// ---

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const schemaPath = "schemas/handoff-template.json";
const templatePaths = [
  "src/test-fixtures/standard-delivery/handoff-templates/standard.md",
  "src/test-fixtures/standard-delivery/handoff-templates/remediation.md",
] as const;

const metadata = async (path: string): Promise<Record<string, unknown>> => {
  const serialized = await readFile(path, "utf8");
  const boundary = serialized.indexOf("\n---\n", 4);
  if (!serialized.startsWith("---\n") || boundary === -1) {
    throw new Error(`${path} has no front matter`);
  }
  return parse(serialized.slice(4, boundary)) as Record<string, unknown>;
};

describe("handoff template artifacts", () => {
  it.each(templatePaths)(
    "validates %s against its declared schema",
    async (path) => {
      const schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;
      const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
        schema,
      );
      const value = await metadata(path);

      expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
      expect(value["$schema"]).toBe(
        "https://wyrd.company/heddle/handoff-template.schema.json",
      );
      expect(basename(path, extname(path))).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      expect(value).not.toHaveProperty("id");
    },
  );

  it("binds one template to each handoff kind", async () => {
    await expect(Promise.all(templatePaths.map(metadata))).resolves.toEqual([
      expect.objectContaining({ kind: "standard" }),
      expect.objectContaining({ kind: "remediation" }),
    ]);
  });
});
