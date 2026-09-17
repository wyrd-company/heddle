/**
 * Pull-request link rules for a thread projection. Links are identified by
 * host, repository, and number, compared case-insensitively. The legacy
 * `linkedPullRequest` field is derived on the server from the project's
 * repository identity, which a thread projection does not hold, so it is
 * left as the snapshot delivered it. No I/O.
 */
import type {
  ThreadPullRequestKey,
  ThreadPullRequestLink,
} from "../schemas/orchestration/commands/pull-request-model.js";
import type { OrchestrationEvent } from "../schemas/orchestration/events.js";
import type { OrchestrationThread } from "../schemas/orchestration/read-model.js";

type PullRequestSynced = Extract<
  OrchestrationEvent,
  { type: "thread.pull-request-synced" }
>["payload"];

export function pullRequestKeysEqual(
  left: ThreadPullRequestKey,
  right: ThreadPullRequestKey,
): boolean {
  return pullRequestKeyOf(left) === pullRequestKeyOf(right);
}

function pullRequestKeyOf(key: ThreadPullRequestKey): string {
  return `${key.host.trim().toLowerCase()}/${key.repository.trim().toLowerCase()}#${key.number}`;
}

export function applyPullRequestLinked(
  thread: OrchestrationThread,
  link: ThreadPullRequestLink,
  at: string,
): OrchestrationThread {
  const index = thread.pullRequests.findIndex((entry) => pullRequestKeysEqual(entry, link));
  const pullRequests =
    index === -1
      ? [...thread.pullRequests, link]
      : thread.pullRequests.map((entry, i) => (i === index ? link : entry));
  return { ...thread, pullRequests, updatedAt: at };
}

export function applyPullRequestUnlinked(
  thread: OrchestrationThread,
  key: ThreadPullRequestKey,
  at: string,
): OrchestrationThread {
  const pullRequests = thread.pullRequests.filter((entry) => !pullRequestKeysEqual(entry, key));
  return { ...thread, pullRequests, updatedAt: at };
}

/** A sync for a link that was removed in the meantime is stale and leaves the thread unchanged. */
export function applyPullRequestSynced(
  thread: OrchestrationThread,
  payload: PullRequestSynced,
): OrchestrationThread {
  if (!thread.pullRequests.some((entry) => pullRequestKeysEqual(entry, payload))) return thread;
  const pullRequests = thread.pullRequests.map((entry) =>
    pullRequestKeysEqual(entry, payload)
      ? { ...entry, snapshot: payload.snapshot, stack: payload.stack }
      : entry,
  );
  return { ...thread, pullRequests, updatedAt: payload.updatedAt };
}
