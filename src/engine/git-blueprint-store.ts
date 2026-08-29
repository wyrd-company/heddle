// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type { LifecycleBlueprint } from "./types.js";
import { BlueprintValidationError } from "./errors.js";

const execFileAsync = promisify(execFile);
const gitObjectId = /^[0-9a-f]{40,64}$/;

const parseBlueprint = (serialized: string): LifecycleBlueprint => {
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
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("nodes" in value) ||
    !Array.isArray(value.nodes) ||
    !("edges" in value) ||
    !Array.isArray(value.edges)
  ) {
    throw new BlueprintValidationError(
      "Blueprint must contain a string id and node and edge arrays",
    );
  }
  return value as LifecycleBlueprint;
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
    return {
      blobHash,
      blueprint: await this.read(blobHash),
      path: relative(this.repositoryRoot, repositoryPath),
    };
  }

  async read(blobHash: string): Promise<LifecycleBlueprint> {
    if (!gitObjectId.test(blobHash)) {
      throw new BlueprintValidationError("Invalid blueprint git blob hash");
    }
    const { stdout } = await execFileAsync(
      "git",
      ["cat-file", "blob", blobHash],
      { cwd: this.repositoryRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    return parseBlueprint(stdout);
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
