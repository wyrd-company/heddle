// ---
// relationships:
//   implements: heddle
// ---

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

import { validateBlueprint } from "./blueprint.js";
import { isBlueprintArtifactId } from "./blueprint-artifact.js";
import { preserveUnchangedGraphBytes } from "./blueprint-graph-serialization.js";
import { BlueprintValidationError } from "./errors.js";
import { GitBlueprintStore } from "./git-blueprint-store.js";
import type { BlueprintRepositoryTransaction } from "./git-blueprint-store.js";
import type {
  LifecycleBlueprint,
  LifecycleEdge,
  LifecycleEffect,
  LifecycleNode,
} from "./types.js";

const blueprintSchemaPath = resolve(
  import.meta.dirname,
  "../../schemas/lifecycle-blueprint.json",
);

export interface BlueprintArtifactRevision {
  blobHash: string;
  blueprint: LifecycleBlueprint;
  path: string;
  positions: Record<string, { x: number; y: number }>;
}

export interface SaveBlueprintArtifactInput {
  artifactId: string;
  edges: LifecycleEdge[];
  expectedBlobHash: string;
  nodes: LifecycleNode[];
  positions: Record<string, { x: number; y: number }>;
}

const artifactPath = (artifactId: string): string => {
  if (!isBlueprintArtifactId(artifactId)) {
    throw new BlueprintValidationError(
      "Blueprint artifact ID must be a kebab ID",
    );
  }
  return `blueprints/${artifactId}.json`;
};

const finitePositions = (
  value: unknown,
): Record<string, { x: number; y: number }> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [nodeId, position] of Object.entries(value)) {
    if (
      !isBlueprintArtifactId(nodeId) ||
      typeof position !== "object" ||
      position === null ||
      Array.isArray(position) ||
      typeof position["x"] !== "number" ||
      !Number.isFinite(position["x"]) ||
      typeof position["y"] !== "number" ||
      !Number.isFinite(position["y"])
    ) {
      continue;
    }
    positions[nodeId] = { x: position["x"], y: position["y"] };
  }
  return positions;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positionsFrom = (
  artifact: Record<string, unknown>,
): Record<string, { x: number; y: number }> => {
  const metadata = artifact["metadata"];
  if (!isRecord(metadata)) return {};
  const canvas = metadata["canvas"];
  if (!isRecord(canvas)) return {};
  return finitePositions(canvas["positions"]);
};

const withPositions = (
  artifact: Record<string, unknown>,
  positions: Record<string, { x: number; y: number }>,
): Record<string, unknown> => {
  const metadata = isRecord(artifact["metadata"]) ? artifact["metadata"] : {};
  const canvas = isRecord(metadata["canvas"]) ? metadata["canvas"] : {};
  return {
    ...artifact,
    metadata: {
      ...metadata,
      canvas: { ...canvas, positions },
    },
  };
};

const schemaError = (error: ErrorObject): string => {
  const property =
    "additionalProperty" in error.params &&
    typeof error.params.additionalProperty === "string"
      ? ` ${JSON.stringify(error.params.additionalProperty)}`
      : "";
  return `${error.instancePath || "/"}${property} ${error.message ?? error.keyword}`;
};

export class BlueprintArtifactEditor {
  private readonly effects: Record<string, LifecycleEffect>;
  private readonly store: GitBlueprintStore;
  private readonly transaction: BlueprintRepositoryTransaction;
  private validator?: ValidateFunction;

  constructor(options: {
    effects: Record<string, LifecycleEffect>;
    repositoryRoot: string;
    transaction?: BlueprintRepositoryTransaction;
  }) {
    this.effects = { ...options.effects };
    this.store = new GitBlueprintStore(options.repositoryRoot);
    this.transaction = options.transaction ?? {};
  }

  async load(artifactId: string): Promise<BlueprintArtifactRevision> {
    const inspected = await this.store.inspect(artifactPath(artifactId));
    return {
      blobHash: inspected.blobHash,
      blueprint: inspected.blueprint,
      path: inspected.path,
      positions: positionsFrom(inspected.artifact),
    };
  }

  async save(
    input: SaveBlueprintArtifactInput,
  ): Promise<BlueprintArtifactRevision> {
    const path = artifactPath(input.artifactId);
    const current = await this.store.inspect(path);
    const cleanPositions = finitePositions(input.positions);
    if (
      Object.keys(cleanPositions).length !== Object.keys(input.positions).length
    ) {
      throw new BlueprintValidationError(
        "Blueprint canvas positions must use kebab node IDs and finite coordinates",
      );
    }
    const artifact = withPositions(
      {
        ...current.artifact,
        nodes: input.nodes,
        edges: input.edges,
      },
      cleanPositions,
    );
    const validator = await this.schemaValidator();
    if (!validator(artifact)) {
      throw new BlueprintValidationError(
        `Blueprint schema violation: ${(validator.errors ?? []).map(schemaError).join("; ")}`,
      );
    }
    const blueprint = {
      ...artifact,
      id: input.artifactId,
    } as LifecycleBlueprint;
    validateBlueprint(blueprint, this.effects);
    const canonical = `${JSON.stringify(artifact, null, 2)}\n`;
    const serialized = preserveUnchangedGraphBytes(
      current.serialized,
      canonical,
    );
    const saved = await this.store.replace(
      path,
      input.expectedBlobHash,
      serialized,
      this.transaction,
    );
    return {
      blobHash: saved.blobHash,
      blueprint: saved.blueprint,
      path: saved.path,
      positions: positionsFrom(saved.artifact),
    };
  }

  private async schemaValidator(): Promise<ValidateFunction> {
    if (this.validator !== undefined) return this.validator;
    const schema = JSON.parse(
      await readFile(blueprintSchemaPath, "utf8"),
    ) as object;
    const validator = new Ajv2020({ allErrors: true, strict: false }).compile(
      schema,
    );
    this.validator = validator;
    return validator;
  }
}
