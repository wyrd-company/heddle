// ---
// relationships:
//   implements: heddle
// ---

import { join } from "node:path";

import type { BoardTask } from "../board-adapter/index.js";
import type { T3DispatchCommand } from "../control-plane/t3-control-plane-client.js";
import { describeError } from "../error-details.js";
import {
  ensureWorktree,
  type WorktreeInput,
} from "../control-plane/worktree-creator.js";
import type {
  EpicProjectRecord,
  SqlitePersistence,
} from "../persistence/index.js";
import type { ReconcilerAttentionQueue } from "../reconciler/index.js";
import type { ResolvedProductionConfiguration } from "./configuration.js";
import { createProductionErrorAttention } from "./error-visibility.js";
import type { ProductRoutingCatalog } from "./product-routing.js";
import { stableUuid } from "./stable-uuid.js";

export interface EpicProjectT3Client {
  dispatch(command: T3DispatchCommand): Promise<{ sequence: number }>;
}

export type EpicProjectAction = {
  epicId: number;
  kind: "created";
  projectId: string;
};

export class EpicProjectCoordinator {
  constructor(
    private readonly configuration: ResolvedProductionConfiguration,
    private readonly persistence: SqlitePersistence,
    private readonly routing: ProductRoutingCatalog,
    private readonly t3: EpicProjectT3Client,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly prepareWorktree: (
      input: WorktreeInput,
    ) => Promise<unknown> = ensureWorktree,
    private readonly attention?: ReconcilerAttentionQueue,
  ) {
    for (const product of configuration.products) {
      if (product.epicProject === undefined) continue;
      const epicId = product.epicProject.epicId;
      const prior = this.persistence.getEpicProject(epicId);
      if (prior === undefined) {
        this.persistence.writeEpicProject(
          this.recordFor(
            epicId,
            product.name,
            product.epicProject.projectId,
            "active",
          ),
        );
      } else if (
        prior.productName !== product.name ||
        prior.projectId !== product.epicProject.projectId
      ) {
        throw new Error(`Epic ${epicId} changed configured project identity`);
      }
    }
  }

  async reconcile(tasks: readonly BoardTask[]): Promise<EpicProjectAction[]> {
    this.routing.update(tasks);
    const actions: EpicProjectAction[] = [];
    const epics = tasks
      .filter(({ tags }) => tags.includes("type:epic"))
      .sort((left, right) => left.id - right.id);
    for (const epic of epics) {
      try {
        if (epic.status === "in-progress") {
          const created = await this.ensureActive(epic);
          if (created !== undefined) actions.push(created);
        }
      } catch (error) {
        if (this.attention === undefined) throw error;
        const attentionId = `production:epic-project-reconciliation-failed:task:${epic.id}`;
        if (!(await this.attention.has(attentionId))) {
          await this.attention.raise(
            createProductionErrorAttention({
              attentionId,
              code: "epic-project-reconciliation-failed",
              error,
              message: `Epic ${epic.id} project reconciliation failed: ${describeError(error)}`,
              taskId: epic.id,
            }),
          );
        }
      }
    }
    return actions;
  }

  projectForTask(task: BoardTask): string {
    if (task.parent === undefined)
      return this.configuration.adHocProject.projectId;
    const project = this.persistence.getEpicProject(task.parent);
    if (project?.state !== "active") {
      throw new Error(
        `Epic ${task.parent} has no active T3 project for task ${task.id}`,
      );
    }
    return project.projectId;
  }

  baseBranchForTask(task: BoardTask): string {
    if (task.parent === undefined) return this.configuration.session.baseRef;
    this.projectForTask(task);
    return `epic/${task.parent}`;
  }

  private async ensureActive(
    epic: BoardTask,
  ): Promise<EpicProjectAction | undefined> {
    const route = this.routing.route(epic);
    let record = this.persistence.getEpicProject(epic.id);
    if (record !== undefined && record.productName !== route.product.name) {
      throw new Error(`Epic ${epic.id} changed durable product identity`);
    }
    if (record?.state === "active") return undefined;
    if (record?.state === "deleting" || record?.state === "deleted") {
      throw new Error(`Epic ${epic.id} project deletion cannot be reversed`);
    }
    if (record === undefined) {
      record = this.recordFor(
        epic.id,
        route.product.name,
        stableUuid(`epic:${epic.id}:project`),
        "creating",
      );
      this.persistence.writeEpicProject(record);
    }
    for (const repository of route.repositories) {
      await this.prepareWorktree({
        baseRef: this.configuration.session.baseRef,
        branch: `epic/${epic.id}`,
        repositoryName: repository.name,
        repositoryRoot: repository.repositoryRoot,
        worktreeName: String(epic.id),
        ...(this.configuration.session.worktreesRoot === undefined
          ? {}
          : { worktreesRoot: this.configuration.session.worktreesRoot }),
      });
    }
    await this.t3.dispatch({
      commandId: record.createCommandId,
      createdAt: record.createdAt,
      projectId: record.projectId,
      title: `${route.product.name} - epic-${epic.id}`,
      type: "project.create",
      workspaceRoot: join(
        this.configuration.session.worktreesRoot ?? "/workspaces/worktrees",
        String(epic.id),
      ),
    });
    this.persistence.writeEpicProject({ ...record, state: "active" });
    return { epicId: epic.id, kind: "created", projectId: record.projectId };
  }

  private recordFor(
    epicId: number,
    productName: string,
    projectId: string,
    state: EpicProjectRecord["state"],
  ): EpicProjectRecord {
    return {
      createCommandId: stableUuid(`epic:${epicId}:project:create`),
      createdAt: this.now(),
      deleteCommandId: stableUuid(`epic:${epicId}:project:delete`),
      epicId,
      productName,
      projectId,
      state,
    };
  }
}
