// ---
// relationships:
//   implements: heddle
// ---

import { isRepositoryScope, type BoardTask } from "../board-adapter/index.js";
import type { JsonValue } from "../persistence/index.js";

const json = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

export const taskContractWithRepositoryScope = (
  task: BoardTask,
  repositoryNames: readonly string[] | undefined = task.repos,
): JsonValue => {
  const contract = { ...task } as Partial<BoardTask>;
  delete contract.frontMatter;
  return json({
    ...contract,
    ...(repositoryNames === undefined ? {} : { repos: repositoryNames }),
  });
};

export const taskFrontMatterWithRepositoryScope = (
  task: BoardTask,
  repositoryNames: readonly string[],
): JsonValue =>
  json({
    ...(typeof task.frontMatter === "object" &&
    task.frontMatter !== null &&
    !Array.isArray(task.frontMatter)
      ? task.frontMatter
      : {}),
    repos: repositoryNames,
  });

export const retainedTaskRepositoryScope = (
  serializedContext: string | null,
  taskId: number,
): string[] | undefined => {
  if (serializedContext === null) return undefined;
  let context: unknown;
  try {
    context = JSON.parse(serializedContext) as unknown;
  } catch {
    throw new Error(`Task ${taskId} has invalid retained lifecycle context`);
  }
  if (
    typeof context !== "object" ||
    context === null ||
    Array.isArray(context)
  ) {
    throw new Error(`Task ${taskId} has invalid retained lifecycle context`);
  }
  const taskContract = (context as Record<string, unknown>)["taskContract"];
  if (
    typeof taskContract !== "object" ||
    taskContract === null ||
    Array.isArray(taskContract) ||
    (taskContract as Record<string, unknown>)["id"] !== taskId
  ) {
    return undefined;
  }
  const repositories = (taskContract as Record<string, unknown>)["repos"];
  if (repositories === undefined) return undefined;
  if (!isRepositoryScope(repositories)) {
    throw new Error(`Task ${taskId} has invalid retained repository scope`);
  }
  return repositories;
};

export const requireRetainedTaskRepositoryScope = (
  serializedContext: string | null,
  taskId: number,
): string[] => {
  const repositories = retainedTaskRepositoryScope(serializedContext, taskId);
  if (repositories === undefined) {
    throw new Error(
      `Task ${taskId} has no retained repository scope; operator recovery is required`,
    );
  }
  return repositories;
};
