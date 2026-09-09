// ---
// relationships:
//   implements: heddle
// ---

export const providerAliasPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const isProviderAlias = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 64 &&
  providerAliasPattern.test(value);

export type TaskProviderAliasMap = Readonly<Record<string, string>>;

export class TaskProviderAliasError extends Error {
  public readonly reason = "provider-alias-not-allowed" as const;

  public constructor(
    public readonly taskId: number,
    detail: string,
  ) {
    super(
      `provider-alias-not-allowed: task ${taskId} provider-alias ${detail}`,
    );
    this.name = "TaskProviderAliasError";
  }
}

const valueShape = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a sequence";
  if (typeof value === "string" && value === "") return "an empty string";
  return typeof value === "object" ? "a mapping" : typeof value;
};

export const parseTaskProviderAliasMap = (
  value: unknown,
  taskId: number,
): TaskProviderAliasMap | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskProviderAliasError(
      taskId,
      `must be a stage-to-alias mapping; received ${valueShape(value)}`,
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [stageId, alias] of entries) {
    if (!isProviderAlias(alias)) {
      throw new TaskProviderAliasError(
        taskId,
        `key ${JSON.stringify(stageId)} must name a lower-kebab alias of at most 64 characters; received ${valueShape(alias)}`,
      );
    }
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
};

export const taskProviderAliasForStage = (
  aliases: TaskProviderAliasMap | undefined,
  stageId: string,
): string | undefined =>
  aliases !== undefined && Object.hasOwn(aliases, stageId)
    ? aliases[stageId]
    : undefined;
