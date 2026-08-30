// ---
// relationships:
//   implements: heddle
// ---

import { createHash } from "node:crypto";
import { join } from "node:path";

import type { BoardTask } from "../board-adapter/index.js";
import type { T3DispatchCommand } from "../control-plane/t3-control-plane-client.js";
import {
  ensureWorktree,
  type WorktreeInput,
} from "../control-plane/worktree-creator.js";
import type {
  EpicProjectRecord,
  SqlitePersistence,
} from "../persistence/index.js";
import type { ProductionConfiguration } from "./configuration.js";
import type { ProductRoutingCatalog } from "./product-routing.js";

export interface EpicProjectT3Client {
  dispatch(command: T3DispatchCommand): Promise<{ sequence: number }>;
}

export type EpicProjectAction = {
  epicId: number;
  kind: "created" | "deleted";
  projectId: string;
};

const stableUuid = (seed: string): string => {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
};

export class EpicProjectCoordinator {
  constructor(
    private readonly configuration: ProductionConfiguration,
    private readonly persistence: SqlitePersistence,
    private readonly routing: ProductRoutingCatalog,
    private readonly t3: EpicProjectT3Client,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly prepareWorktree: (
      input: WorktreeInput,
    ) => Promise<unknown> = ensureWorktree,
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
      if (epic.status === "in-progress") {
        const created = await this.ensureActive(epic);
        if (created !== undefined) actions.push(created);
      } else if (epic.status === "done") {
        const deleted = await this.ensureDeleted(epic.id);
        if (deleted !== undefined) actions.push(deleted);
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

  private async ensureActive(
    epic: BoardTask,
  ): Promise<EpicProjectAction | undefined> {
    const route = this.routing.route(epic);
    let record = this.persistence.getEpicProject(epic.id);
    if (record !== undefined && record.productName !== route.product.name) {
      throw new Error(`Epic ${epic.id} changed durable product identity`);
    }
    if (record?.state === "active") return undefined;
    if (record?.state === "deleting") {
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

  private async ensureDeleted(
    epicId: number,
  ): Promise<EpicProjectAction | undefined> {
    const existing = this.persistence.getEpicProject(epicId);
    if (existing === undefined) return undefined;
    const deleting = { ...existing, state: "deleting" as const };
    this.persistence.writeEpicProject(deleting);
    await this.t3.dispatch({
      commandId: deleting.deleteCommandId,
      force: true,
      projectId: deleting.projectId,
      type: "project.delete",
    });
    this.persistence.deleteEpicProject(epicId);
    return { epicId, kind: "deleted", projectId: deleting.projectId };
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
