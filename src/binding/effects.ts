// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { EngineNodeContext } from "../engine/types.js";
import type { RunStore } from "../engine/store.js";
import type { GitHub } from "../github/src/github.js";
import { parseIssueRef } from "../github/src/refs.js";
import { GitHubError } from "../github/src/transport/errors.js";
import type { FieldValue } from "../github/src/schema/types.js";
import type { BoundProject } from "./reconcile.js";
import type { IssueSnapshot } from "./snapshot.js";
import type { InstanceStore } from "./store.js";
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
export function issueHandle(client: GitHub, issue: IssueSnapshot) {
  const coords = parseIssueRef(issue.ref);
  return client.owner(coords.owner).repo(coords.repo).issue(coords.number);
}
export async function setCard(
  project: BoundProject,
  issue: IssueSnapshot,
  field: string,
  value: FieldValue | null,
): Promise<void> {
  const card = project.item(
    issue.project.itemId as Parameters<BoundProject["item"]>[0],
  );
  const current = await card.get();
  if (!isDeepStrictEqual(current[field] ?? null, value))
    await card.set({ [field]: value });
  issue.project.fields[field] = value;
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
  const handle = issueHandle(client, issue);
  switch (params["operation"]) {
    case "set-field": {
      const field = params["field"];
      if (typeof field !== "string" || !Object.hasOwn(params, "value"))
        throw new Error("set-field requires field and value");
      if (field === "Status" || field === "Paused")
        throw new Error(`${field} is owned by the service`);
      if (
        params["scope"] !== undefined &&
        params["scope"] !== "project" &&
        params["scope"] !== "organization"
      )
        throw new Error("set-field scope must be project or organization");
      const value = fieldValue(params["value"]);
      if (params["scope"] === "organization") {
        if (
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value)
        )
          throw new Error("Organization field cannot use an iteration value");
        const current = await handle.load();
        if (
          !isDeepStrictEqual(
            (current.fields as Record<string, unknown>)[field] ?? null,
            value,
          )
        )
          await handle.set({ fields: { [field]: value } });
        issue.fields[field] = value as
          string | number | readonly string[] | null;
      } else await setCard(project, issue, field, value);
      break;
    }
    case "comment": {
      if (typeof params["body"] !== "string")
        throw new Error("comment requires body");
      const marker = `<!-- heddle-effect:${createHash("sha256").update(context.effectKey).digest("hex")} -->`;
      let found = false;
      for await (const comment of handle.comments())
        if (comment.body.endsWith(marker)) found = true;
      if (!found) await handle.comment(`${params["body"]}\n\n${marker}`);
      break;
    }
    case "add-labels": {
      const labels = params["labels"];
      if (!Array.isArray(labels) || !labels.every((x) => typeof x === "string"))
        throw new Error("add-labels requires string labels");
      const current = await handle.load();
      const missing = labels.filter(
        (label) => !current.labels.some((existing) => existing.name === label),
      );
      if (missing.length) await handle.set({ labels: { add: missing } });
      issue.labels = (await handle.load()).labels;
      break;
    }
    default:
      throw new Error(
        `Unsupported GitHub operation: ${String(params["operation"])}`,
      );
  }
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

function fieldValue(value: unknown): FieldValue | null {
  if (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return value;
  if (
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    "title" in value &&
    typeof value.title === "string"
  )
    return { title: value.title };
  throw new Error("set-field value must be a supported field value or null");
}
