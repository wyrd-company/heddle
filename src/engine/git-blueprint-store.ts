// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

import type { LifecycleBlueprint } from "./types.js";
import { BlueprintValidationError } from "./errors.js";

const execFileAsync = promisify(execFile);
const gitObjectId = /^[0-9a-f]{40,64}$/;
const artifactIdPattern = /^[a-z]+(?:-[a-z]+)*$/;

const artifactIdFromPath = (path: string): string => {
  if (extname(path) !== ".json") {
    throw new BlueprintValidationError(
      "Blueprint artifact path must end in .json",
    );
  }
  const artifactId = basename(path, ".json");
  if (!artifactIdPattern.test(artifactId)) {
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
