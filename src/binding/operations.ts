// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Data } from "../engine/types.js";
import type { GitHub } from "../github/src/github.js";
import type { IssueData } from "../github/src/issues/issue.js";
import { parseIssueRef } from "../github/src/refs.js";
import type {
  FieldValue,
  IssueFieldSchema,
} from "../github/src/schema/types.js";
import type { BoundProject } from "./reconcile.js";
import type { IssueSnapshot } from "./snapshot.js";

export function issueHandle(client: GitHub, issue: IssueSnapshot) {
  const coords = parseIssueRef(issue.ref);
  return client.owner(coords.owner).repo(coords.repo).issue(coords.number);
}
export type IssueHandle = ReturnType<typeof issueHandle>;

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

export interface OperationContext {
  readonly params: Data;
  readonly effectKey: string;
  readonly project: BoundProject;
  readonly handle: IssueHandle;
  readonly issue: IssueSnapshot;
}
export type GitHubOperation = (context: OperationContext) => Promise<void>;

/** The closed-state reasons a blueprint may author. */
export const CLOSE_REASONS = ["completed", "not-planned"] as const;
type CloseReason = (typeof CLOSE_REASONS)[number];

/** Carries the operation's own outcome into the run's issue context. */
function observe(
  issue: IssueSnapshot,
  loaded: IssueData<IssueFieldSchema>,
): void {
  issue.state = loaded.state;
  issue.stateReason = loaded.stateReason;
  issue.labels = loaded.labels;
  issue.updatedAt = loaded.updatedAt;
}

function stringList(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(message);
  return value;
}

function closeReason(value: unknown): CloseReason {
  if (value === undefined) return "completed";
  if (!CLOSE_REASONS.includes(value as CloseReason))
    throw new Error(`close reason must be ${CLOSE_REASONS.join(" or ")}`);
  return value as CloseReason;
}

const setField: GitHubOperation = async ({ params, project, handle, issue }) => {
  const field = params["field"];
  if (typeof field !== "string" || !Object.hasOwn(params, "value"))
    throw new Error("set-field requires field and value");
  if (field === "Status" || field === "Paused")
    throw new Error(`${field} is owned by the service`);
  const scope = params["scope"];
  if (scope !== undefined && scope !== "project" && scope !== "organization")
    throw new Error("set-field scope must be project or organization");
  const value = fieldValue(params["value"]);
  if (scope !== "organization") {
    await setCard(project, issue, field, value);
    return;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    throw new Error("Organization field cannot use an iteration value");
  const current = await handle.load();
  if (
    !isDeepStrictEqual(
      (current.fields as Record<string, unknown>)[field] ?? null,
      value,
    )
  )
    await handle.set({ fields: { [field]: value } });
  issue.fields[field] = value as string | number | readonly string[] | null;
};

const comment: GitHubOperation = async ({ params, handle, effectKey }) => {
  if (typeof params["body"] !== "string")
    throw new Error("comment requires body");
  const marker = `<!-- heddle-effect:${createHash("sha256").update(effectKey).digest("hex")} -->`;
  let found = false;
  for await (const existing of handle.comments())
    if (existing.body.endsWith(marker)) found = true;
  if (!found) await handle.comment(`${params["body"]}\n\n${marker}`);
};

const addLabels: GitHubOperation = async ({ params, handle, issue }) => {
  const labels = stringList(
    params["labels"],
    "add-labels requires string labels",
  );
  const current = await handle.load();
  const missing = labels.filter(
    (label) => !current.labels.some((existing) => existing.name === label),
  );
  if (missing.length) await handle.set({ labels: { add: missing } });
  issue.labels = (await handle.load()).labels;
};

const removeLabels: GitHubOperation = async ({ params, handle, issue }) => {
  const labels = stringList(
    params["labels"],
    "remove-labels requires string labels",
  );
  const current = await handle.load();
  const present = labels.filter((label) =>
    current.labels.some((existing) => existing.name === label),
  );
  if (!present.length) {
    observe(issue, current);
    return;
  }
  await handle.set({ labels: { remove: present } });
  observe(issue, await handle.load());
};

const close: GitHubOperation = async ({ params, handle, issue }) => {
  const reason = closeReason(params["reason"]);
  const current = await handle.load();
  if (current.state === "closed" && current.stateReason === reason) {
    observe(issue, current);
    return;
  }
  await handle.close({ reason });
  observe(issue, await handle.load());
};

const reopen: GitHubOperation = async ({ handle, issue }) => {
  const current = await handle.load();
  if (current.state === "open") {
    observe(issue, current);
    return;
  }
  await handle.reopen();
  observe(issue, await handle.load());
};

/** The operations a `github` node can run. Availability is read from here. */
export const GITHUB_OPERATIONS: Readonly<Record<string, GitHubOperation>> = {
  "set-field": setField,
  comment,
  "add-labels": addLabels,
  "remove-labels": removeLabels,
  close,
  reopen,
};

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
