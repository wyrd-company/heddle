// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import jsonata from "jsonata";
import type { EngineNode } from "../engine/types.js";
import type { IssueSnapshot } from "./snapshot.js";

export const onIssueChange: EngineNode = async (context) => {
  const issue = context.context["issue"] as IssueSnapshot | undefined;
  if (!issue?.id)
    throw new Error("on-issue-change requires a bound issue snapshot");
  const condition = context.params["when"];
  if (condition !== undefined && typeof condition !== "string")
    throw new Error("on-issue-change when must be a JSONata expression");
  const declarations: unknown = context.params["bindings"] ?? {};
  if (typeof declarations !== "object" || Array.isArray(declarations))
    throw new Error("on-issue-change bindings must be a mapping");
  const bindings: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(
    declarations as Record<string, unknown>,
  )) {
    if (typeof path !== "string")
      throw new Error(`on-issue-change binding ${name} must be a path`);
    const value = await (jsonata(path).evaluate(
      context.run.initialContext,
    ) as Promise<unknown>);
    if (value === undefined)
      throw new Error(`Unknown on-issue-change bound value: ${name}`);
    bindings[name] = structuredClone(value);
  }
  await context.await({
    kind: "issue-change",
    issueId: issue.id,
    ...(condition === undefined ? {} : { condition }),
    bindings,
  });
};
