// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import { createHmac, timingSafeEqual } from "node:crypto";

export const githubEvents = [
  "issues",
  "projects_v2_item",
  "issue_comment",
  "pull_request",
] as const;
export type GitHubEvent = (typeof githubEvents)[number];

export interface IssueDelivery {
  event: GitHubEvent;
  issueId: string;
  updatedAt: string;
  relatedRef?: `${string}/${string}#${number}`;
}

type DeliveryHandler = (delivery: IssueDelivery) => Promise<boolean>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`GitHub delivery requires ${name}`);
  return value;
}

function issueFromPayload(event: GitHubEvent, payload: unknown): IssueDelivery {
  const root = record(payload);
  if (!root) throw new Error("GitHub delivery payload must be an object");
  const source =
    event === "projects_v2_item"
      ? record(root["projects_v2_item"])
      : (record(root["issue"]) ?? record(root["pull_request"]));
  if (!source)
    throw new Error(`GitHub ${event} delivery has no issue identity`);
  const repository = record(root["repository"]);
  const repositoryName = repository?.["full_name"];
  const pullNumber = source["number"];
  const relatedRef =
    event === "pull_request" &&
    typeof repositoryName === "string" &&
    /^[^/]+\/[^/]+$/u.test(repositoryName) &&
    typeof pullNumber === "number"
      ? (`${repositoryName}#${String(pullNumber)}` as `${string}/${string}#${number}`)
      : undefined;
  return {
    event,
    issueId: requiredString(
      source["node_id"] ?? source["content_node_id"] ?? source["id"],
      "an issue node id",
    ),
    updatedAt: requiredString(
      source["updated_at"] ?? root["updated_at"],
      "an updated time",
    ),
    ...(relatedRef === undefined ? {} : { relatedRef }),
  };
}

function supported(value: string): value is GitHubEvent {
  return (githubEvents as readonly string[]).includes(value);
}

export class GitHubEventHandler {
  constructor(private readonly apply: DeliveryHandler) {}

  async deliver(event: string, payload: unknown): Promise<boolean> {
    if (!supported(event))
      throw new Error(`Unsupported GitHub event: ${event}`);
    return this.apply(issueFromPayload(event, payload));
  }

  async webhook(
    event: string,
    signature: string,
    body: Uint8Array,
    secret: string,
  ): Promise<boolean> {
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (
      actualBytes.length !== expectedBytes.length ||
      !timingSafeEqual(actualBytes, expectedBytes)
    )
      throw new Error("GitHub webhook signature is invalid");
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
    } catch {
      throw new Error("GitHub webhook body is invalid JSON");
    }
    if (!/^[a-z][a-z0-9_]*$/u.test(event))
      throw new Error("GitHub webhook event name is invalid");
    if (!supported(event)) return false;
    return this.deliver(event, payload);
  }
}
