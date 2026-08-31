// ---
// relationships:
//   verifies: heddle
// ---

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { deliveryBlueprintFixture } from "../engine/lifecycle-blueprint.test-support.js";

const schemaPath = "schemas/todo-template.json";
const templatePaths = [
  "src/test-fixtures/standard-delivery/todo-templates/standard-delivery-implement.json",
  "src/test-fixtures/standard-delivery/todo-templates/standard-delivery-review.json",
  "src/test-fixtures/standard-delivery/todo-templates/standard-delivery-remediate.json",
  "src/test-fixtures/standard-delivery/todo-templates/standard-delivery-retrospective.json",
] as const;

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("todo template artifacts", () => {
  it.each(templatePaths)("validates %s against its schema", async (path) => {
    const schema = await readJson(schemaPath);
    const artifact = await readJson(path);
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
      schema,
    );

    expect(validate(artifact), JSON.stringify(validate.errors)).toBe(true);
  });

  it("binds schema declarations and filename-derived artifact IDs", async () => {
    const schema = (await readJson(schemaPath)) as {
      $id?: unknown;
      relationships?: unknown;
    };
    expect(schema.$id).toBe(
      "https://wyrd.company/heddle/todo-template.schema.json",
    );
    expect(schema.relationships).toEqual({ implements: "heddle" });

    for (const path of templatePaths) {
      const artifact = (await readJson(path)) as {
        $schema?: unknown;
        id?: unknown;
      };
      expect(artifact.$schema).toBe(schema.$id);
      expect(artifact).not.toHaveProperty("id");
      expect(basename(path, extname(path))).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    }
  });

  it("contains one template for every standard-delivery binding", async () => {
    const blueprint = deliveryBlueprintFixture("standard-delivery");
    const bindings = blueprint.nodes
      .map((node) => node["todo-template"])
      .filter((value): value is string => value !== undefined)
      .sort();
    const templates = templatePaths
      .map((path) => basename(path, extname(path)))
      .sort();

    expect(templates).toEqual(bindings);
  });

  it("rejects malformed task placeholder syntax", async () => {
    const schema = await readJson(schemaPath);
    const artifact = (await readJson(templatePaths[0])) as {
      items: Array<{ text: string }>;
    };
    const malformed = cloneJson(artifact);
    malformed.items[0]!.text = "Orient on {{task..title}}";
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
      schema,
    );

    expect(validate(malformed)).toBe(false);
  });
});
