// ---
// relationships:
//   implements: heddle
// ---

import { stat } from "node:fs/promises";
import { join } from "node:path";

import { isBlueprintArtifactId } from "./blueprint-artifact.js";

const lifecycleTagPrefix = "lifecycle:";

export interface LifecycleSelectorTask {
  id: number;
  lifecycle?: string;
  tags?: readonly string[];
}

export interface ResolvedLifecycle {
  artifactId: string;
  blueprintPath: string;
  kind: "resolved";
}

export interface LifecycleResolutionAttention {
  attention: {
    artifactId?: string;
    code:
      | "lifecycle-not-declared"
      | "lifecycle-declaration-invalid"
      | "lifecycle-blueprint-not-found";
    message: string;
    taskId: number;
  };
  kind: "attention-required";
}

export type LifecycleResolution =
  ResolvedLifecycle | LifecycleResolutionAttention;

const attention = (
  taskId: number,
  code: LifecycleResolutionAttention["attention"]["code"],
  message: string,
  artifactId?: string,
): LifecycleResolutionAttention => ({
  attention: {
    ...(artifactId === undefined ? {} : { artifactId }),
    code,
    message,
    taskId,
  },
  kind: "attention-required",
});

const lifecycleTagValues = (tags: readonly string[]): string[] =>
  tags
    .filter((tag) => tag.startsWith(lifecycleTagPrefix))
    .map((tag) => tag.slice(lifecycleTagPrefix.length));

export class LifecycleResolver {
  public constructor(private readonly repositoryRoot: string) {}

  public async resolve(
    task: LifecycleSelectorTask,
  ): Promise<LifecycleResolution> {
    const tagValues = lifecycleTagValues(task.tags ?? []);
    if (task.lifecycle === undefined && tagValues.length > 1) {
      return attention(
        task.id,
        "lifecycle-declaration-invalid",
        `Task ${task.id} has more than one lifecycle tag`,
      );
    }
    const artifactId = task.lifecycle ?? tagValues[0];
    if (artifactId === undefined) {
      return attention(
        task.id,
        "lifecycle-not-declared",
        `Task ${task.id} does not declare a lifecycle`,
      );
    }
    if (!isBlueprintArtifactId(artifactId)) {
      return attention(
        task.id,
        "lifecycle-declaration-invalid",
        `Task ${task.id} declares invalid lifecycle ${artifactId}`,
      );
    }

    const blueprintPath = join("blueprints", `${artifactId}.json`);
    let blueprintExists = false;
    try {
      blueprintExists = (
        await stat(join(this.repositoryRoot, blueprintPath))
      ).isFile();
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    if (!blueprintExists) {
      return attention(
        task.id,
        "lifecycle-blueprint-not-found",
        `Task ${task.id} names missing lifecycle blueprint ${artifactId}`,
        artifactId,
      );
    }
    return { artifactId, blueprintPath, kind: "resolved" };
  }
}
