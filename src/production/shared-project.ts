// ---
// relationships:
//   implements: heddle
// ---

import { randomUUID } from "node:crypto";

import type {
  T3DispatchCommand,
  T3ShellProject,
  T3ShellSnapshot,
} from "../control-plane/t3-control-plane-client.js";
import { describeError } from "../error-details.js";
import type {
  SharedProjectRecord,
  SqlitePersistence,
} from "../persistence/index.js";
import type { ResolvedProductionConfiguration } from "./configuration.js";
import { retainedProjectRecreationError } from "./project-create-conflict.js";
import { stableUuid } from "./stable-uuid.js";

export interface SharedProjectT3Client {
  dispatch(command: T3DispatchCommand): Promise<{ sequence: number }>;
  getShell(): Promise<T3ShellSnapshot>;
}

const normalizedWorkspaceRoot = (value: string): string =>
  value === "/" ? value : value.replace(/\/+$/, "");

export const sharedProjectTitle = (label?: string): string =>
  label === undefined
    ? "Heddle · ad-hoc work"
    : `Heddle · ad-hoc work · ${label.trim()}`;

export class SharedProjectCoordinator {
  public constructor(
    private readonly configuration: ResolvedProductionConfiguration,
    private readonly persistence: SqlitePersistence,
    private readonly t3: SharedProjectT3Client,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly generateProjectId: () => string = randomUUID,
  ) {}

  public async reconcile(): Promise<void> {
    const configured = this.configuration.adHocProject;
    const desiredTitle = sharedProjectTitle(configured.label);
    let record = this.persistence.getSharedProject();
    try {
      const shell = await this.t3.getShell();
      const retainedIdentity = record !== undefined;
      if (record === undefined) {
        this.assertWorkspaceRootAvailable(
          shell.projects,
          configured.workspaceRoot,
        );
        record = this.recordFor(
          this.generateProjectId(),
          desiredTitle,
          configured.workspaceRoot,
          this.now(),
        );
        this.persistence.writeSharedProject(record);
      } else if (
        normalizedWorkspaceRoot(record.workspaceRoot) !==
        normalizedWorkspaceRoot(configured.workspaceRoot)
      ) {
        throw new Error(
          "the durable workspace root differs from configuration",
        );
      }

      const retained = record;
      let project = shell.projects.find(({ id }) => id === retained.projectId);
      if (project === undefined) {
        this.assertWorkspaceRootAvailable(
          shell.projects,
          retained.workspaceRoot,
          retained.projectId,
        );
        try {
          await this.t3.dispatch({
            commandId: retained.createCommandId,
            createdAt: retained.createdAt,
            projectId: retained.projectId,
            title: retained.projectTitle,
            type: "project.create",
            workspaceRoot: retained.workspaceRoot,
          });
        } catch (error) {
          throw retainedIdentity
            ? retainedProjectRecreationError(error, retained.projectId)
            : error;
        }
        project = {
          createdAt: retained.createdAt,
          id: retained.projectId,
          title: retained.projectTitle,
          workspaceRoot: retained.workspaceRoot,
        };
      } else if (
        normalizedWorkspaceRoot(project.workspaceRoot) !==
        normalizedWorkspaceRoot(retained.workspaceRoot)
      ) {
        throw new Error(
          "the control-plane workspace root differs from durable state",
        );
      }

      record = retained;
      if (record.state !== "active") {
        record = { ...record, state: "active" };
        this.persistence.writeSharedProject(record);
      }
      record = await this.finishPendingTitle(record, project.title);
      if (record.projectTitle !== desiredTitle) {
        record = {
          ...record,
          projectTitle: desiredTitle,
          projectTitleApplied: false,
          projectTitleRevision: record.projectTitleRevision + 1,
        };
        this.persistence.writeSharedProject(record);
        await this.updateTitle(record);
        this.persistence.writeSharedProject({
          ...record,
          projectTitleApplied: true,
        });
      }
    } catch (error) {
      const identity =
        record === undefined ? "unprovisioned" : record.projectId;
      throw new Error(
        `Shared project (${identity}) reconciliation failed: ${describeError(error)}`,
        { cause: error },
      );
    }
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
        `T3 project '${collision.id}' survives at workspace root '${workspaceRoot}' without matching Heddle state; restore the paired Heddle state before starting`,
      );
    }
  }

  private async finishPendingTitle(
    record: SharedProjectRecord,
    observedTitle: string,
  ): Promise<SharedProjectRecord> {
    if (record.projectTitleApplied) return record;
    if (observedTitle !== record.projectTitle) await this.updateTitle(record);
    const completed = { ...record, projectTitleApplied: true };
    this.persistence.writeSharedProject(completed);
    return completed;
  }

  private async updateTitle(record: SharedProjectRecord): Promise<void> {
    await this.t3.dispatch({
      commandId: stableUuid(
        `shared-project:${record.projectId}:title:${record.projectTitleRevision}`,
      ),
      projectId: record.projectId,
      title: record.projectTitle,
      type: "project.meta.update",
    });
  }

  private recordFor(
    projectId: string,
    projectTitle: string,
    workspaceRoot: string,
    createdAt: string,
  ): SharedProjectRecord {
    return {
      createCommandId: stableUuid(`shared-project:${projectId}:create`),
      createdAt,
      projectId,
      projectTitle,
      projectTitleApplied: true,
      projectTitleRevision: 0,
      state: "creating",
      workspaceRoot,
    };
  }
}
