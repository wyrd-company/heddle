// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import type { EngineNodeContext } from "../engine/types.js";
import type { RunStore } from "../engine/store.js";
import type { GitHub } from "../github/src/github.js";
import { GitHubError } from "../github/src/transport/errors.js";
import type { BoundProject } from "./reconcile.js";
import { GITHUB_OPERATIONS, issueHandle } from "./operations.js";
import type { IssueSnapshot } from "./snapshot.js";
import type { InstanceStore } from "./store.js";

export { issueHandle, setCard } from "./operations.js";

export async function permissionAttention(
  error: unknown,
  context: EngineNodeContext,
  store: RunStore,
): Promise<void> {
  if (!(error instanceof GitHubError) || error.code !== "FORBIDDEN")
    throw error;
  store.event(context.run.id, "attention", {
    nodeId: context.nodeId,
    refusal: error.message,
    code: error.code,
    requestId: error.requestId,
  });
  await context.await({ kind: "github-attention", message: error.message });
}

export async function githubEffect(
  context: EngineNodeContext,
  project: BoundProject,
  client: GitHub,
  instances: InstanceStore,
): Promise<void> {
  const issue = structuredClone(context.context["issue"]) as
    IssueSnapshot | undefined;
  if (!issue) throw new Error("GitHub node requires a bound issue snapshot");
  const params = context.params;
  const payload = JSON.stringify([issue.id, issue.project.id, params]);
  const completed = instances.completed(context.effectKey, payload);
  if (completed) {
    context.context["issue"] = completed;
    return;
  }
  const operation = GITHUB_OPERATIONS[String(params["operation"])];
  if (!operation)
    throw new Error(
      `Unsupported GitHub operation: ${String(params["operation"])}`,
    );
  await operation({
    params,
    effectKey: context.effectKey,
    project,
    handle: issueHandle(client, issue),
    issue,
  });
  // The completion marker and snapshot share the engine database transaction.
  instances.db.exec("BEGIN IMMEDIATE");
  try {
    instances.update(issue);
    instances.complete(context.effectKey, payload, issue);
    instances.db.exec("COMMIT");
  } catch (error) {
    instances.db.exec("ROLLBACK");
    throw error;
  }
  context.context["issue"] = issue;
}
