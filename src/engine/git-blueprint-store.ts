// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

import { isBlueprintArtifactId } from "./blueprint-artifact.js";
import type { LifecycleBlueprint } from "./types.js";
import { BlueprintValidationError } from "./errors.js";
import { BlueprintEditConflictError } from "./errors.js";

const execFileAsync = promisify(execFile);
const gitObjectId = /^[0-9a-f]{40,64}$/;

const artifactIdFromPath = (path: string): string => {
  if (extname(path) !== ".json") {
    throw new BlueprintValidationError(
      "Blueprint artifact path must end in .json",
    );
  }
  const artifactId = basename(path, ".json");
  if (!isBlueprintArtifactId(artifactId)) {
    throw new BlueprintValidationError(
      "Blueprint artifact filename must be a kebab ID",
    );
  }
  return artifactId;
};

const parseBlueprint = (
  serialized: string,
  artifactId: string,
): LifecycleBlueprint => {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new BlueprintValidationError(
      `Blueprint is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("nodes" in value) ||
    !Array.isArray(value.nodes) ||
    !("edges" in value) ||
    !Array.isArray(value.edges)
  ) {
    throw new BlueprintValidationError(
      "Blueprint must contain node and edge arrays",
    );
  }
  if ("id" in value) {
    throw new BlueprintValidationError(
      "Blueprint artifact ID must come from its filename, not an id field",
    );
  }
  return { ...value, id: artifactId } as LifecycleBlueprint;
};

export interface WorkingBlueprintArtifact {
  artifact: Record<string, unknown>;
  blobHash: string;
  blueprint: LifecycleBlueprint;
  path: string;
  serialized: string;
}

export class GitBlueprintStore {
  constructor(private readonly repositoryRoot: string) {}

  async pin(path: string): Promise<{
    blobHash: string;
    blueprint: LifecycleBlueprint;
    path: string;
  }> {
    const repositoryPath = this.resolveRepositoryPath(path);
    const { stdout: blobHashOutput } = await execFileAsync(
      "git",
      ["hash-object", "-w", "--", repositoryPath],
      { cwd: this.repositoryRoot },
    );
    const blobHash = blobHashOutput.trim();
    await execFileAsync(
      "git",
      ["update-ref", `refs/heddle/blueprints/${blobHash}`, blobHash],
      { cwd: this.repositoryRoot },
    );
    return {
      blobHash,
      blueprint: await this.read(
        blobHash,
        relative(this.repositoryRoot, repositoryPath),
      ),
      path: relative(this.repositoryRoot, repositoryPath),
    };
  }

  normalize(path: string): string {
    return relative(this.repositoryRoot, this.resolveRepositoryPath(path));
  }

  async inspect(path: string): Promise<WorkingBlueprintArtifact> {
    const repositoryPath = this.resolveRepositoryPath(path);
    const normalizedPath = relative(this.repositoryRoot, repositoryPath);
    const serialized = await readFile(repositoryPath, "utf8");
    const blueprint = parseBlueprint(
      serialized,
      artifactIdFromPath(normalizedPath),
    );
    const { stdout } = await execFileAsync(
      "git",
      ["hash-object", "--", repositoryPath],
      { cwd: this.repositoryRoot },
    );
    const artifact = JSON.parse(serialized) as Record<string, unknown>;
    return {
      artifact,
      blobHash: stdout.trim(),
      blueprint,
      path: normalizedPath,
      serialized,
    };
  }

  async replace(
    path: string,
    expectedBlobHash: string,
    serialized: string,
  ): Promise<WorkingBlueprintArtifact> {
    if (!gitObjectId.test(expectedBlobHash)) {
      throw new BlueprintValidationError(
        "Expected blueprint git blob hash is invalid",
      );
    }
    const repositoryPath = this.resolveRepositoryPath(path);
    const current = await this.inspect(path);
    if (current.blobHash !== expectedBlobHash) {
      throw new BlueprintEditConflictError(expectedBlobHash, current.blobHash);
    }
    const temporaryPath = `${repositoryPath}.heddle-${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, serialized, {
        encoding: "utf8",
        flag: "wx",
      });
      const latest = await this.inspect(path);
      if (latest.blobHash !== expectedBlobHash) {
        throw new BlueprintEditConflictError(expectedBlobHash, latest.blobHash);
      }
      await rename(temporaryPath, repositoryPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    return this.inspect(path);
  }

  async read(blobHash: string, path: string): Promise<LifecycleBlueprint> {
    if (!gitObjectId.test(blobHash)) {
      throw new BlueprintValidationError("Invalid blueprint git blob hash");
    }
    const { stdout } = await execFileAsync(
      "git",
      ["cat-file", "blob", blobHash],
      { cwd: this.repositoryRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    return parseBlueprint(stdout, artifactIdFromPath(path));
  }

  private resolveRepositoryPath(path: string): string {
    if (path.trim() === "") {
      throw new BlueprintValidationError("Blueprint path must not be empty");
    }
    const repositoryPath = resolve(this.repositoryRoot, path);
    const repositoryRelativePath = relative(
      this.repositoryRoot,
      repositoryPath,
    );
    if (
      repositoryRelativePath === ".." ||
      repositoryRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(repositoryRelativePath)
    ) {
      throw new BlueprintValidationError(
        "Blueprint path must be inside the repository",
      );
    }
    return repositoryPath;
  }
}
