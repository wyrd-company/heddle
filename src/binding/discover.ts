// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import type { GitHub } from "../github/src/github.js";
import { parseIssueRef } from "../github/src/refs.js";
import type { IssueFieldSchema } from "../github/src/schema/types.js";
import { GitHubError } from "../github/src/transport/errors.js";
import type { ProjectBinding } from "./config.js";
import type { BoundProject } from "./reconcile.js";
import { snapshot, IssueFrontMatterError } from "./snapshot.js";
import type { InstanceStore } from "./store.js";

export interface DiscoverySource {
  binding: ProjectBinding;
  client: GitHub;
  project: BoundProject;
}

/** Every open issue on a bound project board becomes a workflow instance. */
export async function discoverBoundIssues(
  instances: InstanceStore,
  sources: readonly DiscoverySource[],
): Promise<void> {
  for (const source of sources) {
    const { binding } = source;
    try {
      const project = await source.client
        .owner<IssueFieldSchema>(binding.owner)
        .project(binding.number)
        .open();
      for await (const card of project.items({ archived: false })) {
        if (card.type !== "issue" || !card.contentRef) continue;
        const membership = {
          id: project.id,
          owner: binding.owner,
          number: binding.number,
          itemId: card.id,
          fields: card.values,
        };
        const existing = instances.find(card.contentId);
        if (existing) {
          instances.membership({ ...existing.issue, project: membership });
          if (existing.issue.project.id !== project.id)
            instances.projectChoice(existing.id);
          continue;
        }
        const coords = parseIssueRef(card.contentRef);
        const issue = await source.client
          .owner<IssueFieldSchema>(coords.owner)
          .repo(coords.repo)
          .issue(coords.number)
          .load();
        if (issue.state !== "open") continue;
        try {
          instances.discover(snapshot(issue, membership));
        } catch (error) {
          if (!(error instanceof IssueFrontMatterError)) throw error;
          instances.attention(project.id, error.message);
        }
      }
    } catch (error) {
      if (!(error instanceof GitHubError) || error.code !== "FORBIDDEN")
        throw error;
      instances.attention(
        `${binding.owner}/${String(binding.number)}`,
        error.message,
      );
    }
  }
}
