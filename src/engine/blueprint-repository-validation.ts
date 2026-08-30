// ---
// relationships:
//   implements: heddle
// ---

import type { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";

import { validateBlueprint } from "./blueprint.js";
import { isBlueprintArtifactId } from "./blueprint-artifact.js";
import { BlueprintValidationError } from "./errors.js";
import type {
  LifecycleBlueprint,
  LifecycleEffect,
  LifecycleNode,
} from "./types.js";

const schemaPath = resolve(
  import.meta.dirname,
  "../../schemas/lifecycle-blueprint.json",
);

const json = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const effectCatalog = (
  blueprint: LifecycleBlueprint,
): Record<string, LifecycleEffect> =>
  Object.fromEntries(
    blueprint.nodes
      .filter(({ uses }) => uses !== "wait")
      .map(({ uses }) => [uses, async () => ({})]),
  );

const assertTemplateRelationships = (
  artifactId: string,
  artifact: Record<string, unknown>,
  blueprint: LifecycleBlueprint,
): void => {
  const relationships = artifact["relationships"];
  if (!record(relationships) || !Array.isArray(relationships["uses"])) return;
  const bound = blueprint.nodes.flatMap((node) => {
    const values: string[] = [];
    if (node["todo-template"] !== undefined) {
      values.push(node["todo-template"]);
    }
    if (node["handoff-template"] !== undefined) {
      values.push(
        basename(
          node["handoff-template"].path,
          extname(node["handoff-template"].path),
        ),
      );
    }
    return values;
  });
  const declared = relationships["uses"].filter(
    (value): value is string => typeof value === "string",
  );
  if (
    JSON.stringify([...new Set(bound)].sort()) !==
    JSON.stringify([...declared].sort())
  ) {
    throw new BlueprintValidationError(
      `Blueprint '${artifactId}' relationships must name its template artifacts`,
    );
  }
};

const gitBlobHash = (content: Buffer, blobHash: string): string =>
  createHash(blobHash.length === 64 ? "sha256" : "sha1")
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest("hex");

const assertTemplateArtifacts = async (
  artifactId: string,
  nodes: LifecycleNode[],
  repositoryRoot: string,
): Promise<void> => {
  for (const node of nodes) {
    const pinned = node["handoff-template"];
    if (pinned !== undefined) {
      let content: Buffer;
      try {
        content = await readFile(join(repositoryRoot, pinned.path));
      } catch {
        throw new BlueprintValidationError(
          `Blueprint '${artifactId}' node '${node.id}' pins handoff template '${pinned.path}' that is not in the repository`,
        );
      }
      if (gitBlobHash(content, pinned.blobHash) !== pinned.blobHash) {
        throw new BlueprintValidationError(
          `Blueprint '${artifactId}' node '${node.id}' pins handoff template blob ${pinned.blobHash} that does not match '${pinned.path}'`,
        );
      }
    }
    const todoTemplate = node["todo-template"];
    if (todoTemplate !== undefined) {
      const path = join(
        repositoryRoot,
        "todo-templates",
        `${todoTemplate}.json`,
      );
      const artifact = await stat(path).catch(() => undefined);
      if (artifact === undefined || !artifact.isFile()) {
        throw new BlueprintValidationError(
          `Blueprint '${artifactId}' node '${node.id}' names todo template '${todoTemplate}' that has no artifact in todo-templates/`,
        );
      }
    }
  }
};

const assertDeliveryHandoffs = (
  artifactId: string,
  nodes: LifecycleNode[],
): void => {
  if (artifactId !== "standard-delivery" && artifactId !== "trivial") return;
  const handoffs = nodes
    .filter(({ uses }) => uses === "wait")
    .map(({ handoff, id }) => ({ handoff, id }));
  const expected = [
    { handoff: "standard", id: "implement" },
    { handoff: "standard", id: "review" },
    { handoff: "remediation", id: "remediate" },
    ...(artifactId === "standard-delivery"
      ? [{ handoff: "standard" as const, id: "retrospective" }]
      : []),
  ];
  if (JSON.stringify(handoffs) !== JSON.stringify(expected)) {
    throw new BlueprintValidationError(
      `Blueprint '${artifactId}' has inconsistent delivery handoff metadata`,
    );
  }
};

export const validateBlueprintRepository = async (
  repositoryRoot: string,
): Promise<string[]> => {
  const root = resolve(repositoryRoot);
  const directory = join(root, "blueprints");
  const filenames = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name) === ".json")
    .map(({ name }) => name)
    .sort();
  if (filenames.length === 0) {
    throw new BlueprintValidationError(
      "Blueprint repository must contain at least one JSON artifact",
    );
  }
  const schema = await json(schemaPath);
  const validator = new Ajv2020({ allErrors: true, strict: false }).compile(
    schema as object,
  );
  for (const filename of filenames) {
    const artifactId = basename(filename, ".json");
    if (!isBlueprintArtifactId(artifactId)) {
      throw new BlueprintValidationError(
        `Blueprint filename '${filename}' must be a kebab artifact ID`,
      );
    }
    const artifact = await json(join(directory, filename));
    if (!validator(artifact)) {
      throw new BlueprintValidationError(
        `Blueprint '${artifactId}' violates the lifecycle schema: ${JSON.stringify(validator.errors)}`,
      );
    }
    const blueprint = {
      ...(artifact as Record<string, unknown>),
      id: artifactId,
    } as LifecycleBlueprint;
    validateBlueprint(blueprint, effectCatalog(blueprint));
    assertTemplateRelationships(
      artifactId,
      artifact as Record<string, unknown>,
      blueprint,
    );
    assertDeliveryHandoffs(artifactId, blueprint.nodes);
    await assertTemplateArtifacts(artifactId, blueprint.nodes, root);
  }
  return filenames.map((filename) => basename(filename, ".json"));
};
