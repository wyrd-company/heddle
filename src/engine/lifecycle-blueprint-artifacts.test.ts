// ---
// relationships:
//   verifies: heddle
// ---

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const schemaPath = "schemas/lifecycle-blueprint.json";
const blueprintPaths = [
  "blueprints/standard-delivery.json",
  "blueprints/trivial.json",
] as const;

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("lifecycle blueprint artifacts", () => {
  it.each(blueprintPaths)("validates %s against its schema", async (path) => {
    const schema = await readJson(schemaPath);
    const artifact = await readJson(path);
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);

    expect(validate(artifact), JSON.stringify(validate.errors)).toBe(true);
  });

  it("binds every artifact schema declaration to the schema identity", async () => {
    const schema = (await readJson(schemaPath)) as {
      $id?: unknown;
      relationships?: unknown;
    };

    expect(schema.$id).toBe(
      "https://wyrd.company/heddle/lifecycle-blueprint.schema.json",
    );
    expect(schema.relationships).toEqual({ implements: "heddle" });
    expect(basename(schemaPath, extname(schemaPath))).toMatch(
      /^[a-z]+(?:-[a-z]+)*$/,
    );
    for (const path of blueprintPaths) {
      const artifact = (await readJson(path)) as { $schema?: unknown };
      expect(artifact.$schema).toBe(schema.$id);
    }
  });

  it("derives kebab artifact IDs from filenames instead of authored fields", async () => {
    for (const path of blueprintPaths) {
      const artifact = await readJson(path);
      expect(artifact).not.toHaveProperty("id");
      expect(basename(path, extname(path))).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    }
  });

  it.each(blueprintPaths)(
    "binds %s relationships to its todo templates",
    async (path) => {
      const artifact = (await readJson(path)) as {
        nodes: Array<{
          "handoff-template"?: { path: string };
          "todo-template"?: string;
        }>;
        relationships: { uses?: string[] };
      };
      const boundTemplates = [
        ...artifact.nodes
          .map((node) => node["todo-template"])
          .filter((value): value is string => value !== undefined),
        ...artifact.nodes
          .map((node) => node["handoff-template"]?.path)
          .filter((value): value is string => value !== undefined)
          .map((value) => basename(value, extname(value))),
      ];

      expect([...(artifact.relationships.uses ?? [])].sort()).toEqual(
        [...new Set(boundTemplates)].sort(),
      );
    },
  );

  it("marks only the standard-delivery remediation wait as remediation", async () => {
    const artifact = (await readJson(blueprintPaths[0])) as {
      nodes: Array<{ handoff?: string; id: string; uses: string }>;
    };
    const agentWaits = artifact.nodes.filter(({ uses }) => uses === "wait");

    expect(agentWaits.map(({ handoff, id }) => ({ handoff, id }))).toEqual([
      { handoff: "standard", id: "implement" },
      { handoff: "standard", id: "review" },
      { handoff: "remediation", id: "remediate" },
      { handoff: "standard", id: "retrospective" },
    ]);
  });

  it("accepts repository metadata only as a safe wait-stage declaration", async () => {
    const schema = await readJson(schemaPath);
    const artifact = (await readJson(blueprintPaths[0])) as {
      nodes: Array<Record<string, unknown>>;
    };
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
      schema,
    );
    const valid = cloneJson(artifact);
    valid.nodes.find(({ uses }) => uses === "wait")!.repo = "sample-repository";
    expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);

    const invalid = cloneJson(valid);
    invalid.nodes.find(({ uses }) => uses === "wait")!.repo = "../outside";
    expect(validate(invalid)).toBe(false);

    const inconsistent = cloneJson(artifact);
    inconsistent.nodes.find(({ uses }) => uses !== "wait")!.repo =
      "sample-repository";
    expect(validate(inconsistent)).toBe(false);
  });

  it("requires refinery relationships and session-stage bindings", async () => {
    const schema = await readJson(schemaPath);
    const artifact = (await readJson(blueprintPaths[0])) as {
      nodes: Array<Record<string, unknown>>;
      relationships?: unknown;
    };
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);

    const withoutRelationships = cloneJson(artifact);
    delete withoutRelationships.relationships;
    expect(validate(withoutRelationships)).toBe(false);

    const withoutToolSet = cloneJson(artifact);
    const waitNode = withoutToolSet.nodes.find(({ uses }) => uses === "wait");
    if (waitNode === undefined) throw new Error("wait node fixture is missing");
    delete waitNode.tools;
    expect(validate(withoutToolSet)).toBe(false);

    const withoutTodoTemplate = cloneJson(artifact);
    const otherWaitNode = withoutTodoTemplate.nodes.find(
      ({ uses }) => uses === "wait",
    );
    if (otherWaitNode === undefined) {
      throw new Error("wait node fixture is missing");
    }
    delete otherWaitNode["todo-template"];
    expect(validate(withoutTodoTemplate)).toBe(false);

    const withoutHandoff = cloneJson(artifact);
    const handoffWaitNode = withoutHandoff.nodes.find(
      ({ uses }) => uses === "wait",
    );
    if (handoffWaitNode === undefined) {
      throw new Error("wait node fixture is missing");
    }
    delete handoffWaitNode.handoff;
    expect(validate(withoutHandoff)).toBe(false);

    const withoutHandoffTemplate = cloneJson(artifact);
    delete withoutHandoffTemplate.nodes.find(({ uses }) => uses === "wait")![
      "handoff-template"
    ];
    expect(validate(withoutHandoffTemplate)).toBe(false);

    const invalidHandoff = cloneJson(artifact);
    invalidHandoff.nodes.find(({ uses }) => uses === "wait")!.handoff =
      "private";
    expect(validate(invalidHandoff)).toBe(false);

    const inconsistentHandoff = cloneJson(artifact);
    inconsistentHandoff.nodes.find(({ uses }) => uses !== "wait")!.handoff =
      "standard";
    expect(validate(inconsistentHandoff)).toBe(false);

    const withAuthoredArtifactId = { ...artifact, id: "standard-delivery" };
    expect(validate(withAuthoredArtifactId)).toBe(false);
  });
});
