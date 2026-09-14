// ---
// relationships:
//   implements: heddle
// ---

import { join } from "node:path";

import type { BoardTask } from "../board-adapter/index.js";

export type TaskRepository = {
  name: string;
  repositoryRoot: string;
};

export type TaskRepositoryRoute = {
  repositoryNames: readonly string[];
  repositories: readonly TaskRepository[];
};

export type TaskRoutingAttentionCode =
  | "child-repository-scope-declared"
  | "epic-repository-scope-unavailable"
  | "repository-scope-not-declared"
  | "stage-repository-undeclared";

export class TaskRoutingAttentionError extends Error {
  constructor(
    readonly code: TaskRoutingAttentionCode,
    readonly taskId: number,
    message: string,
  ) {
    super(message);
    this.name = "TaskRoutingAttentionError";
  }
}

/** Resolves repository authority only from the task or its epic parent. */
export class TaskRepositoryRouter {
  private tasksById = new Map<number, BoardTask>();

  public constructor(private readonly workspaceRoot: string) {}

  update(tasks: readonly BoardTask[]): void {
    this.tasksById = new Map(tasks.map((task) => [task.id, task]));
  }

  route(task: BoardTask): TaskRepositoryRoute {
    if (task.parent === undefined) {
      if (task.repos === undefined) {
        throw new TaskRoutingAttentionError(
          "repository-scope-not-declared",
          task.id,
          `Task ${task.id} does not declare repository scope in repos`,
        );
      }
      return this.resolved(task.repos);
    }
    if (task.repos !== undefined) {
      throw new TaskRoutingAttentionError(
        "child-repository-scope-declared",
        task.id,
        `Task ${task.id} declares repos instead of inheriting the full repository scope of epic ${task.parent}`,
      );
    }
    const parent = this.tasksById.get(task.parent);
    if (parent?.repos === undefined || !parent.tags.includes("type:epic")) {
      throw new TaskRoutingAttentionError(
        "epic-repository-scope-unavailable",
        task.id,
        `Task ${task.id} cannot resolve repository scope from epic ${task.parent}`,
      );
    }
    return this.resolved(parent.repos);
  }

  repositoriesForStage(
    task: BoardTask,
    requiredRepositoryName?: string,
  ): readonly TaskRepository[] {
    return this.repositoriesForNames(
      task.id,
      this.route(task).repositoryNames,
      requiredRepositoryName,
    );
  }

  repositoriesForNames(
    taskId: number,
    repositoryNames: readonly string[],
    requiredRepositoryName?: string,
  ): readonly TaskRepository[] {
    const repositories = this.resolved(repositoryNames).repositories;
    if (requiredRepositoryName === undefined) return repositories;
    const repository = repositories.find(
      ({ name }) => name === requiredRepositoryName,
    );
    if (repository === undefined) {
      throw new TaskRoutingAttentionError(
        "stage-repository-undeclared",
        taskId,
        `Task ${taskId} stage requires undeclared repository '${requiredRepositoryName}'`,
      );
    }
    return [repository];
  }

  private resolved(repositoryNames: readonly string[]): TaskRepositoryRoute {
    const repositories = repositoryNames.map((name) => ({
      name,
      repositoryRoot: join(this.workspaceRoot, "tools", name),
    }));
    return {
      repositoryNames,
      repositories,
    };
  }
}
