// ---
// relationships:
//   implements: heddle
// ---

import type { BoardTask } from "../board-adapter/index.js";
import { mechanicalNodeUses } from "../control-plane/index.js";
import {
  GitBlueprintStore,
  LifecycleResolver,
  type LifecycleResolution,
} from "../engine/index.js";
import {
  ProductRoutingCatalog,
  TaskRoutingAttentionError,
} from "./product-routing.js";
import type { OrganizationBlueprintRepository } from "./blueprint-repository.js";

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
  constructor(
    private readonly routing: ProductRoutingCatalog,
    private readonly repository: OrganizationBlueprintRepository,
  ) {}

  async resolve(task: BoardTask): Promise<LifecycleResolution> {
    try {
      this.routing.route(task);
    } catch (error) {
      if (error instanceof TaskRoutingAttentionError) {
        return routingAttention(task, error);
      }
      throw error;
    }
    const resolution = await new LifecycleResolver(
      this.repository.repositoryRoot,
      { sourceRef: this.repository.sourceRef },
    ).resolve(task);
    if (resolution.kind === "attention-required") return resolution;
    const pinned = await new GitBlueprintStore(this.repository.repositoryRoot, {
      sourceRef: this.repository.sourceRef,
    }).pin(resolution.blueprintPath);
    const repositoryBoundUses = new Set<string>([
      "wait",
      ...mechanicalNodeUses,
    ]);
    try {
      for (const node of pinned.blueprint.nodes.filter(({ uses }) =>
        repositoryBoundUses.has(uses),
      )) {
        this.routing.repositoryForStage(task, node.repo);
      }
    } catch (error) {
      if (error instanceof TaskRoutingAttentionError) {
        return routingAttention(task, error);
      }
      throw error;
    }
    return resolution;
  }
}
