// ---
// relationships:
//   implements: heddle
// ---

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { BoardTask } from "../board-adapter/index.js";
import type {
  T3DispatchCommand,
  T3ShellProject,
  T3ShellSnapshot,
} from "../control-plane/t3-control-plane-client.js";
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
import { classifyRetainedProjectCreateError } from "./project-create-conflict.js";
import type { TaskRepositoryRouter } from "./repository-routing.js";
import { stableUuid } from "./stable-uuid.js";

export interface EpicProjectT3Client {
  dispatch(command: T3DispatchCommand): Promise<{ sequence: number }>;
  getShell(): Promise<T3ShellSnapshot>;
}

export type EpicProjectAction = {
  epicId: number;
  kind: "created";
  projectId: string;
};

const normalizedWorkspaceRoot = (value: string): string =>
  value === "/" ? value : value.replace(/\/+$/, "");

export const epicProjectTitle = (
  epic: Pick<BoardTask, "id" | "title">,
): string => `${epic.title} - epic-${epic.id}`;

export class EpicProjectCoordinator {
  constructor(
    private readonly configuration: ResolvedProductionConfiguration,
    private readonly persistence: SqlitePersistence,
    private readonly routing: TaskRepositoryRouter,
    private readonly t3: EpicProjectT3Client,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly prepareWorktree: (
      input: WorktreeInput,
    ) => Promise<unknown> = ensureWorktree,
    private readonly attention?: ReconcilerAttentionQueue,
    private readonly generateProjectId: () => string = randomUUID,
  ) {}

  async reconcile(tasks: readonly BoardTask[]): Promise<EpicProjectAction[]> {
    this.routing.update(tasks);
    const actions: EpicProjectAction[] = [];
    const epics = tasks
      .filter(({ tags }) => tags.includes("type:epic"))
      .sort((left, right) => left.id - right.id);
    const shell = await this.t3.getShell();
    for (const epic of epics) {
      const attentionId = `production:epic-project-reconciliation-failed:task:${epic.id}`;
      try {
        if (epic.status === "in-progress") {
          const created = await this.ensureActive(epic, shell);
          if (created !== undefined) actions.push(created);
          if (
            this.attention !== undefined &&
            (await this.attention.has(attentionId))
          ) {
            this.attention.resolve(attentionId);
          }
        }
      } catch (error) {
        if (this.attention === undefined) throw error;
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
    if (task.parent === undefined) {
      const shared = this.persistence.getSharedProject();
      if (shared?.state !== "active") {
        throw new Error(
          `The shared T3 project is not active for task ${task.id}`,
        );
      }
      return shared.projectId;
    }
    const project = this.persistence.getEpicProject(task.parent);
    if (
      project?.repositoryNames === undefined &&
      (project?.state === "active" || project?.state === "creating")
    ) {
      throw new Error(
        `Epic ${task.parent} has no durable repository scope; operator recovery is required`,
      );
    }
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
    shell: T3ShellSnapshot,
  ): Promise<EpicProjectAction | undefined> {
    const route = this.routing.route(epic);
    const repositoryNames = [...route.repositoryNames];
    const desiredTitle = epicProjectTitle(epic);
    const workspaceRoot = join(
      this.configuration.session.worktreesRoot ?? "/workspaces/worktrees",
      String(epic.id),
    );
    let record = this.persistence.getEpicProject(epic.id);
    const retainedIdentity = record !== undefined;
    if (record?.state === "deleting" || record?.state === "deleted") {
      throw new Error(`Epic ${epic.id} project deletion cannot be reversed`);
    }
    if (record !== undefined && record.repositoryNames === undefined) {
      throw new Error(
        `Epic ${epic.id} has no durable repository scope; operator recovery is required`,
      );
    }
    if (
      record !== undefined &&
      JSON.stringify(record.repositoryNames) !== JSON.stringify(repositoryNames)
    ) {
      throw new Error(`Epic ${epic.id} changed durable repository scope`);
    }
    if (record === undefined) {
      this.assertWorkspaceRootAvailable(shell.projects, workspaceRoot);
      record = this.recordFor(
        epic.id,
        desiredTitle,
        repositoryNames,
        this.generateProjectId(),
        "creating",
      );
      this.persistence.writeEpicProject(record);
    }
    const retained = record;
    let project = shell.projects.find(({ id }) => id === retained.projectId);
    if (project !== undefined) {
      if (
        normalizedWorkspaceRoot(project.workspaceRoot) !==
        normalizedWorkspaceRoot(workspaceRoot)
      ) {
        throw new Error(
          `Epic ${epic.id} control-plane workspace root differs from durable state`,
        );
      }
    } else {
      this.assertWorkspaceRootAvailable(
        shell.projects,
        workspaceRoot,
        retained.projectId,
      );
    }
    record = retained;
    if (record.state !== "active" || project === undefined) {
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
    }
    let created = false;
    if (project === undefined) {
      try {
        await this.t3.dispatch({
          commandId: record.createCommandId,
          createdAt: record.createdAt,
          projectId: record.projectId,
          title: record.projectTitle,
          type: "project.create",
          workspaceRoot,
        });
      } catch (error) {
        throw retainedIdentity
          ? classifyRetainedProjectCreateError(error, record.projectId)
          : error;
      }
      project = {
        createdAt: record.createdAt,
        id: record.projectId,
        title: record.projectTitle,
        workspaceRoot,
      };
      created = true;
    }
    if (record.state !== "active") {
      record = { ...record, state: "active" };
      this.persistence.writeEpicProject(record);
      created = true;
    }
    record = await this.finishPendingTitle(record, project.title);
    if (record.projectTitle !== desiredTitle) {
      record = {
        ...record,
        projectTitle: desiredTitle,
        projectTitleApplied: false,
        projectTitleRevision: record.projectTitleRevision + 1,
      };
      this.persistence.writeEpicProject(record);
      await this.updateTitle(record);
      this.persistence.writeEpicProject({
        ...record,
        projectTitleApplied: true,
      });
    }
    return created
      ? { epicId: epic.id, kind: "created", projectId: record.projectId }
      : undefined;
  }

  private assertWorkspaceRootAvailable(
    projects: readonly T3ShellProject[],
    workspaceRoot: string,
    expectedProjectId?: string,
  ): void {
    const collision = projects.find(
      ({ id, workspaceRoot: existingRoot }) =>
        id !== expectedProjectId &&
        normalizedWorkspaceRoot(existingRoot) ===
          normalizedWorkspaceRoot(workspaceRoot),
    );
    if (collision !== undefined) {
      throw new Error(
        `T3 project '${collision.id}' survives at epic workspace root '${workspaceRoot}' without matching Heddle state; restore the paired Heddle state before starting`,
      );
    }
  }

  private async finishPendingTitle(
    record: EpicProjectRecord,
    observedTitle: string,
  ): Promise<EpicProjectRecord> {
    if (record.projectTitleApplied) return record;
    if (observedTitle !== record.projectTitle) await this.updateTitle(record);
    const completed = { ...record, projectTitleApplied: true };
    this.persistence.writeEpicProject(completed);
    return completed;
  }

  private async updateTitle(record: EpicProjectRecord): Promise<void> {
    await this.t3.dispatch({
      commandId: stableUuid(
        `epic-project:${record.projectId}:title:${record.projectTitleRevision}`,
      ),
      projectId: record.projectId,
      title: record.projectTitle,
      type: "project.meta.update",
    });
  }

  private recordFor(
    epicId: number,
    projectTitle: string,
    repositoryNames: string[],
    projectId: string,
    state: EpicProjectRecord["state"],
  ): EpicProjectRecord {
    return {
      createCommandId: stableUuid(`epic-project:${projectId}:create`),
      createdAt: this.now(),
      deleteCommandId: stableUuid(`epic-project:${projectId}:delete`),
      epicId,
      projectTitle,
      projectTitleApplied: true,
      projectTitleRevision: 0,
      projectId,
      repositoryNames,
      state,
    };
  }
}
