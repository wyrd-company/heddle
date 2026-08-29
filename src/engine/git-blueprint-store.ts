// ---
// relationships:
//   implements: heddle
// ---

import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fileSystemConstants, type Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";

import { isBlueprintArtifactId } from "./blueprint-artifact.js";
import type { LifecycleBlueprint } from "./types.js";
import { BlueprintValidationError } from "./errors.js";
import { BlueprintEditConflictError } from "./errors.js";
import { acquireRepositoryWriterLease } from "./repository-writer-lease.js";

const execFileAsync = promisify(execFile);
const gitObjectId = /^[0-9a-f]{40,64}$/;

interface BlueprintDirectory {
  artifactPath: string;
  directory: FileHandle;
  directoryPath: string;
  expectedRealPath: string;
  normalizedPath: string;
}

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
  private readonly repositoryRoot: string;

  constructor(repositoryRoot: string) {
    this.repositoryRoot = resolve(repositoryRoot);
  }

  async pin(path: string): Promise<{
    blobHash: string;
    blueprint: LifecycleBlueprint;
    path: string;
  }> {
    const inspected = await this.inspect(path);
    const blobHash = await this.hashSerialized(
      inspected.serialized,
      inspected.path,
      true,
    );
    await execFileAsync(
      "git",
      ["update-ref", `refs/heddle/blueprints/${blobHash}`, blobHash],
      { cwd: this.repositoryRoot },
    );
    return {
      blobHash,
      blueprint: inspected.blueprint,
      path: inspected.path,
    };
  }

  normalize(path: string): string {
    return this.normalizeArtifactPath(path);
  }

  async inspect(path: string): Promise<WorkingBlueprintArtifact> {
    const directory = await this.openBlueprintDirectory(path);
    try {
      return await this.inspectFromDirectory(directory);
    } finally {
      await directory.directory.close();
    }
  }

  private async inspectFromDirectory(
    directory: BlueprintDirectory,
  ): Promise<WorkingBlueprintArtifact> {
    await this.assertBlueprintDirectory(directory);
    const artifact = await this.openArtifact(directory);
    let serialized: string;
    try {
      serialized = await artifact.readFile("utf8");
      await this.assertArtifactFile(directory, artifact);
    } finally {
      await artifact.close();
    }
    const blueprint = parseBlueprint(
      serialized,
      artifactIdFromPath(directory.normalizedPath),
    );
    const blobHash = await this.hashSerialized(
      serialized,
      directory.normalizedPath,
    );
    const artifactValue = JSON.parse(serialized) as Record<string, unknown>;
    return {
      artifact: artifactValue,
      blobHash,
      blueprint,
      path: directory.normalizedPath,
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
    const lease = await acquireRepositoryWriterLease(this.repositoryRoot);
    let replaced: WorkingBlueprintArtifact;
    try {
      const directory = await this.openBlueprintDirectory(path);
      try {
        const current = await this.inspectFromDirectory(directory);
        this.assertExpectedBlob(expectedBlobHash, current.blobHash);
        const temporaryPath = `${directory.artifactPath}.heddle-${randomUUID()}.tmp`;
        try {
          const temporary = await open(
            temporaryPath,
            fileSystemConstants.O_CREAT |
              fileSystemConstants.O_EXCL |
              fileSystemConstants.O_NOFOLLOW |
              fileSystemConstants.O_WRONLY,
            0o600,
          );
          try {
            await temporary.writeFile(serialized, "utf8");
            await temporary.sync();
          } finally {
            await temporary.close();
          }
          const latest = await this.inspectFromDirectory(directory);
          this.assertExpectedBlob(expectedBlobHash, latest.blobHash);
          await this.beforeArtifactRename();
          await lease.assertOwned();
          await this.assertBlueprintDirectory(directory);
          const final = await this.inspectFromDirectory(directory);
          this.assertExpectedBlob(expectedBlobHash, final.blobHash);
          await rename(temporaryPath, directory.artifactPath);
          await directory.directory.sync();
          replaced = await this.inspectFromDirectory(directory);
        } finally {
          await rm(temporaryPath, { force: true });
        }
      } finally {
        await directory.directory.close();
      }
    } finally {
      await lease.release();
    }
    return replaced!;
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

  protected hashSerialized(
    serialized: string,
    path: string,
    write = false,
  ): Promise<string> {
    return new Promise((resolveHash, rejectHash) => {
      const child = spawn(
        "git",
        ["hash-object", ...(write ? ["-w"] : []), `--path=${path}`, "--stdin"],
        { cwd: this.repositoryRoot },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", rejectHash);
      child.once("close", (code) => {
        if (code === 0) {
          resolveHash(Buffer.concat(stdout).toString("utf8").trim());
          return;
        }
        rejectHash(
          new Error(
            `git hash-object failed (${code ?? "signal"}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
      });
      child.stdin.end(serialized, "utf8");
    });
  }

  protected beforeArtifactRename(): Promise<void> {
    return Promise.resolve();
  }

  private assertExpectedBlob(expected: string, actual: string): void {
    if (actual !== expected) {
      throw new BlueprintEditConflictError(expected, actual);
    }
  }

  private normalizeArtifactPath(path: string): string {
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
    const normalizedPath = relative(this.repositoryRoot, repositoryPath);
    if (
      dirname(normalizedPath) !== "blueprints" ||
      basename(normalizedPath) !== normalizedPath.slice("blueprints/".length)
    ) {
      throw new BlueprintValidationError(
        "Blueprint path must be a direct child of the blueprint directory",
      );
    }
    artifactIdFromPath(normalizedPath);
    return normalizedPath;
  }

  private async openBlueprintDirectory(
    path: string,
  ): Promise<BlueprintDirectory> {
    const normalizedPath = this.normalizeArtifactPath(path);
    const lexicalDirectory = join(this.repositoryRoot, "blueprints");
    const repositoryRealPath = await realpath(this.repositoryRoot);
    const expectedRealPath = join(repositoryRealPath, "blueprints");
    let lexicalStatus: Stats;
    try {
      lexicalStatus = await lstat(lexicalDirectory);
    } catch (error) {
      throw this.physicalContainmentError(error);
    }
    if (!lexicalStatus.isDirectory() || lexicalStatus.isSymbolicLink()) {
      throw this.physicalContainmentError();
    }
    let directory: FileHandle;
    try {
      directory = await open(
        lexicalDirectory,
        fileSystemConstants.O_DIRECTORY |
          fileSystemConstants.O_NOFOLLOW |
          fileSystemConstants.O_RDONLY,
      );
    } catch (error) {
      throw this.physicalContainmentError(error);
    }
    const opened: BlueprintDirectory = {
      artifactPath: join(
        `/proc/self/fd/${directory.fd}`,
        basename(normalizedPath),
      ),
      directory,
      directoryPath: `/proc/self/fd/${directory.fd}`,
      expectedRealPath,
      normalizedPath,
    };
    try {
      await this.assertBlueprintDirectory(opened);
      return opened;
    } catch (error) {
      await directory.close();
      throw error;
    }
  }

  private async assertBlueprintDirectory(
    directory: BlueprintDirectory,
  ): Promise<void> {
    let openedRealPath: string;
    try {
      openedRealPath = await realpath(directory.directoryPath);
    } catch (error) {
      throw this.physicalContainmentError(error);
    }
    if (openedRealPath !== directory.expectedRealPath) {
      throw this.physicalContainmentError();
    }
  }

  private async openArtifact(
    directory: BlueprintDirectory,
  ): Promise<FileHandle> {
    let artifactStatus: Stats;
    try {
      artifactStatus = await lstat(directory.artifactPath);
    } catch (error) {
      throw this.physicalContainmentError(error);
    }
    if (!artifactStatus.isFile() || artifactStatus.isSymbolicLink()) {
      throw this.physicalContainmentError();
    }
    try {
      const artifact = await open(
        directory.artifactPath,
        fileSystemConstants.O_NOFOLLOW | fileSystemConstants.O_RDONLY,
      );
      await this.assertArtifactFile(directory, artifact);
      return artifact;
    } catch (error) {
      throw this.physicalContainmentError(error);
    }
  }

  private async assertArtifactFile(
    directory: BlueprintDirectory,
    artifact: FileHandle,
  ): Promise<void> {
    const artifactStatus = await artifact.stat();
    if (!artifactStatus.isFile()) throw this.physicalContainmentError();
    let artifactRealPath: string;
    try {
      artifactRealPath = await realpath(`/proc/self/fd/${artifact.fd}`);
    } catch (error) {
      throw this.physicalContainmentError(error);
    }
    if (dirname(artifactRealPath) !== directory.expectedRealPath) {
      throw this.physicalContainmentError();
    }
  }

  private physicalContainmentError(cause?: unknown): BlueprintValidationError {
    return new BlueprintValidationError(
      `Blueprint artifact must be a physical regular file inside the repository blueprint directory${cause instanceof Error ? `: ${cause.message}` : ""}`,
    );
  }
}
