// ---
// relationships:
//   implements: heddle
// ---

import { join } from "node:path";

import { isBlueprintArtifactId } from "./blueprint-artifact.js";
import { GitBlueprintStore } from "./git-blueprint-store.js";

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
  repositoryName?: string;
}

export interface LifecycleResolutionAttention {
  attention: {
    artifactId?: string;
    code:
      | "lifecycle-not-declared"
      | "lifecycle-declaration-invalid"
      | "lifecycle-blueprint-not-found"
      | "lifecycle-blueprint-ambiguous"
      | "product-not-declared"
      | "repository-not-declared"
      | "stage-repository-not-declared"
      | "stage-repository-undeclared";
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
  private readonly store: GitBlueprintStore;

  public constructor(
    repositoryRoot: string,
    options: { sourceRef?: string } = {},
  ) {
    this.store = new GitBlueprintStore(repositoryRoot, options);
  }

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
    const blueprintExists = await this.store.has(blueprintPath);
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
