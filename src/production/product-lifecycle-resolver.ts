// ---
// relationships:
//   implements: heddle
// ---

import type { BoardTask } from "../board-adapter/index.js";
import { mechanicalNodeUses } from "../control-plane/index.js";
import {
  GitBlueprintStore,
  LifecycleResolver,
  validateTaskProviderAliases as validateProviderAliases,
  type LifecycleResolution,
} from "../engine/index.js";
import type { TaskProviderAliasMap } from "../provider-alias.js";
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
  private readonly blueprintStore: GitBlueprintStore;
  private readonly lifecycleResolver: LifecycleResolver;

  constructor(
    private readonly routing: ProductRoutingCatalog,
    repository: OrganizationBlueprintRepository,
  ) {
    this.blueprintStore = new GitBlueprintStore(repository.repositoryRoot, {
      sourceRef: repository.sourceRef,
    });
    this.lifecycleResolver = new LifecycleResolver(repository.repositoryRoot, {
      sourceRef: repository.sourceRef,
    });
  }

  async resolve(task: BoardTask): Promise<LifecycleResolution> {
    try {
      this.routing.route(task);
    } catch (error) {
      if (error instanceof TaskRoutingAttentionError) {
        return routingAttention(task, error);
      }
      throw error;
    }
    const resolution = await this.lifecycleResolver.resolve(task);
    if (resolution.kind === "attention-required") return resolution;
    const pinned = await this.blueprintStore.pin(resolution.blueprintPath);
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

  async validateTaskProviderAliases(
    task: BoardTask,
    aliases: TaskProviderAliasMap | undefined,
  ): Promise<void> {
    if (aliases === undefined) return;
    const resolution = await this.lifecycleResolver.resolve(task);
    if (resolution.kind === "attention-required") {
      throw new Error(resolution.attention.message);
    }
    const pinned = await this.blueprintStore.pin(resolution.blueprintPath);
    validateProviderAliases(pinned.blueprint, task.id, aliases);
  }
}
