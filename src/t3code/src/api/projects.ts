/**
 * ProjectsApi: projects as the shell snapshot sees them, idempotent `ensure`
 * keyed by the normalised workspace root, and thin typed wrappers over the
 * `projects.*` file RPCs.
 */
import { resolve } from "node:path";
import type { RpcClient } from "../rpc/client.js";
import type { RpcMethods } from "../rpc/registry.js";
import type { ProjectId } from "../schemas/common.js";
import type { ModelSelection } from "../schemas/orchestration/model.js";
import type { ProjectMetaUpdateCommand } from "../schemas/orchestration/commands/project.js";
import type { OrchestrationProjectShell } from "../schemas/orchestration/shell.js";
import type {
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "../schemas/projects.js";
import type { HttpTransport } from "../transport/http.js";
import { isMissingResourceError, type CommandDispatcher } from "./dispatch.js";
import { loadShellSnapshot } from "./shell.js";

export interface ProjectCreateInput {
  readonly projectId?: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly createWorkspaceRootIfMissing?: boolean;
  readonly defaultModelSelection?: ModelSelection | null;
}

export interface ProjectEnsureInput {
  readonly workspaceRoot: string;
  readonly title: string;
  readonly createWorkspaceRootIfMissing?: boolean;
}

export type ProjectMetaUpdate = Omit<ProjectMetaUpdateCommand, "type" | "commandId" | "projectId">;

export interface ProjectFilesApi {
  list(input: ProjectListEntriesInput, signal?: AbortSignal): Promise<ProjectListEntriesResult>;
  read(input: ProjectReadFileInput, signal?: AbortSignal): Promise<ProjectReadFileResult>;
  write(input: ProjectWriteFileInput, signal?: AbortSignal): Promise<ProjectWriteFileResult>;
  searchEntries(
    input: ProjectSearchEntriesInput,
    signal?: AbortSignal,
  ): Promise<ProjectSearchEntriesResult>;
  searchContents(
    input: ProjectSearchContentsInput,
    signal?: AbortSignal,
  ): Promise<ProjectSearchContentsResult>;
}

/** Absolute, no trailing separators: the key `ensure` and `findByWorkspaceRoot` compare on. */
export function normalizeWorkspaceRoot(workspaceRoot: string): string {
  const trimmed = workspaceRoot.trim().replace(/[\\/]+$/u, "");
  return resolve(trimmed.length === 0 ? "/" : trimmed);
}

export class ProjectsApi {
  readonly files: ProjectFilesApi;

  constructor(
    readonly http: HttpTransport,
    readonly rpc: RpcClient<RpcMethods>,
    readonly dispatcher: CommandDispatcher,
  ) {
    this.files = {
      list: (input, signal) => rpc.call("projects.listEntries", input, signal),
      read: (input, signal) => rpc.call("projects.readFile", input, signal),
      write: (input, signal) => rpc.call("projects.writeFile", input, signal),
      searchEntries: (input, signal) => rpc.call("projects.searchEntries", input, signal),
      searchContents: (input, signal) => rpc.call("projects.searchContents", input, signal),
    };
  }

  async list(signal?: AbortSignal): Promise<OrchestrationProjectShell[]> {
    return (await loadShellSnapshot(this.http, signal)).projects;
  }

  async get(
    projectId: ProjectId,
    signal?: AbortSignal,
  ): Promise<OrchestrationProjectShell | undefined> {
    return (await this.list(signal)).find((project) => project.id === projectId);
  }

  async findByWorkspaceRoot(
    workspaceRoot: string,
    signal?: AbortSignal,
  ): Promise<OrchestrationProjectShell | undefined> {
    const key = normalizeWorkspaceRoot(workspaceRoot);
    return (await this.list(signal)).find(
      (project) => normalizeWorkspaceRoot(project.workspaceRoot) === key,
    );
  }

  async create(
    input: ProjectCreateInput,
    signal?: AbortSignal,
  ): Promise<OrchestrationProjectShell> {
    const projectId = input.projectId ?? this.dispatcher.newProjectId();
    const createdAt = this.dispatcher.now();
    await this.dispatcher.dispatch(
      {
        type: "project.create",
        commandId: this.dispatcher.newCommandId(),
        projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        ...(input.createWorkspaceRootIfMissing === undefined
          ? {}
          : { createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing }),
        ...(input.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: input.defaultModelSelection }),
        createdAt,
      },
      signal,
    );
    // The projection is applied inside the dispatch transaction, so the shell already has it.
    return (
      (await this.get(projectId, signal)) ?? {
        id: projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        defaultModelSelection: input.defaultModelSelection ?? null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      }
    );
  }

  /** Finds the project for `workspaceRoot` or creates it; renames it only when the title differs. */
  async ensure(
    input: ProjectEnsureInput,
    signal?: AbortSignal,
  ): Promise<OrchestrationProjectShell> {
    const existing = await this.findByWorkspaceRoot(input.workspaceRoot, signal);
    if (!existing) return this.create(input, signal);
    if (existing.title === input.title) return existing;
    await this.update(existing.id, { title: input.title }, signal);
    return { ...existing, title: input.title };
  }

  async update(
    projectId: ProjectId,
    patch: ProjectMetaUpdate,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.dispatcher.dispatch(
      {
        ...patch,
        type: "project.meta.update",
        commandId: this.dispatcher.newCommandId(),
        projectId,
      },
      signal,
    );
  }

  /** Resolves when the project is gone, including when it never existed. */
  async delete(
    projectId: ProjectId,
    options: { readonly force?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.dispatcher.dispatch(
        {
          type: "project.delete",
          commandId: this.dispatcher.newCommandId(),
          projectId,
          ...(options.force === undefined ? {} : { force: options.force }),
        },
        signal,
      );
    } catch (error) {
      if (!isMissingResourceError(error)) throw error;
    }
  }
}
