// ---
// relationships:
//   implements: heddle
// ---

import type { BoardTask } from "../board-adapter/index.js";
import {
  GitBlueprintStore,
  LifecycleResolver,
  type LifecycleResolution,
} from "../engine/index.js";
import {
  ProductRoutingCatalog,
  TaskRoutingAttentionError,
} from "./product-routing.js";

const routingAttention = (
  task: BoardTask,
  error: TaskRoutingAttentionError,
): LifecycleResolution => ({
  attention: {
    code: error.code,
    message: error.message,
    taskId: task.id,
  },
  kind: "attention-required",
});

export class ProductLifecycleResolver {
  constructor(private readonly routing: ProductRoutingCatalog) {}

  async resolve(task: BoardTask): Promise<LifecycleResolution> {
    let route;
    try {
      route = this.routing.route(task);
    } catch (error) {
      if (error instanceof TaskRoutingAttentionError) {
        return routingAttention(task, error);
      }
      throw error;
    }
    const resolutions = await Promise.all(
      route.repositories.map(async (repository) => ({
        repository,
        resolution: await new LifecycleResolver(
          repository.repositoryRoot,
        ).resolve(task),
      })),
    );
    const declarationAttention = resolutions.find(
      ({ resolution }) =>
        resolution.kind === "attention-required" &&
        resolution.attention.code !== "lifecycle-blueprint-not-found",
    );
    if (declarationAttention !== undefined) {
      return declarationAttention.resolution;
    }
    const resolved = resolutions.filter(
      (
        candidate,
      ): candidate is typeof candidate & {
        resolution: Extract<LifecycleResolution, { kind: "resolved" }>;
      } => candidate.resolution.kind === "resolved",
    );
    if (resolved.length === 0) return resolutions[0]!.resolution;
    if (resolved.length > 1) {
      return {
        attention: {
          artifactId: resolved[0]!.resolution.artifactId,
          code: "lifecycle-blueprint-ambiguous",
          message: `Task ${task.id} lifecycle exists in more than one declared repository`,
          taskId: task.id,
        },
        kind: "attention-required",
      };
    }
    const selected = resolved[0]!;
    const pinned = await new GitBlueprintStore(
      selected.repository.repositoryRoot,
    ).pin(selected.resolution.blueprintPath);
    try {
      for (const node of pinned.blueprint.nodes.filter(
        ({ uses }) => uses === "wait",
      )) {
        this.routing.repositoryForStage(task, node.repo);
      }
    } catch (error) {
      if (error instanceof TaskRoutingAttentionError) {
        return routingAttention(task, error);
      }
      throw error;
    }
    return {
      ...selected.resolution,
      repositoryName: selected.repository.name,
    };
  }
}
