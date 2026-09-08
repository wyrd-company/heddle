// ---
// relationships:
//   implements: heddle
// ---

import type {
  T3DispatchCommand,
  T3ShellSnapshot,
} from "../control-plane/t3-control-plane-client.js";
import { describeError } from "../error-details.js";
import type {
  SharedProjectRecord,
  SqlitePersistence,
} from "../persistence/index.js";
import type { ResolvedProductionConfiguration } from "./configuration.js";
import { stableUuid } from "./stable-uuid.js";

export interface SharedProjectT3Client {
  dispatch(command: T3DispatchCommand): Promise<{ sequence: number }>;
  getShell(): Promise<T3ShellSnapshot>;
}

const normalizedWorkspaceRoot = (value: string): string =>
  value === "/" ? value : value.replace(/\/+$/, "");

export class SharedProjectCoordinator {
  public constructor(
    private readonly configuration: ResolvedProductionConfiguration,
    private readonly persistence: SqlitePersistence,
    private readonly t3: SharedProjectT3Client,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async reconcile(): Promise<void> {
    const configured = this.configuration.adHocProject;
    try {
      let record = this.persistence.getSharedProject();
      if (
        record !== undefined &&
        (record.projectName !== configured.name ||
          record.projectId !== configured.projectId ||
          record.workspaceRoot !== configured.workspaceRoot)
      ) {
        throw new Error("the durable identity differs from configuration");
      }

      const shell = await this.t3.getShell();
      const project = shell.projects.find(
        ({ id }) => id === configured.projectId,
      );
      if (project !== undefined) {
        if (
          project.title !== configured.name ||
          normalizedWorkspaceRoot(project.workspaceRoot) !==
            normalizedWorkspaceRoot(configured.workspaceRoot)
        ) {
          throw new Error(
            "the control-plane identity differs from configuration",
          );
        }
        record ??= this.recordFor(project.createdAt ?? this.now());
        this.persistence.writeSharedProject({ ...record, state: "active" });
        return;
      }

      record ??= this.recordFor(this.now());
      this.persistence.writeSharedProject({ ...record, state: "creating" });
      await this.t3.dispatch({
        commandId: record.createCommandId,
        createdAt: record.createdAt,
        projectId: record.projectId,
        title: record.projectName,
        type: "project.create",
        workspaceRoot: record.workspaceRoot,
      });
      this.persistence.writeSharedProject({ ...record, state: "active" });
    } catch (error) {
      throw new Error(
        `Shared project '${configured.name}' (${configured.projectId}) reconciliation failed: ${describeError(error)}`,
        { cause: error },
      );
    }
  }

  private recordFor(createdAt: string): SharedProjectRecord {
    const configured = this.configuration.adHocProject;
    return {
      createCommandId: stableUuid(
        `shared-project:${configured.projectId}:create`,
      ),
      createdAt,
      projectId: configured.projectId,
      projectName: configured.name,
      state: "creating",
      workspaceRoot: configured.workspaceRoot,
    };
  }
}
