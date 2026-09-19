// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import type {
  ValidationFinding,
  ValidationOptions,
} from "../blueprints/types.js";
import { validateBlueprintPath } from "../blueprints/validate.js";
import type { ClientFactory, ProjectBinding } from "./config.js";
import { parseIssueRef } from "../github/src/refs.js";
import { issueFrontMatter } from "./snapshot.js";

export async function liveRequirementFacts(
  clients: ClientFactory,
  bindings: readonly ProjectBinding[],
): Promise<NonNullable<ValidationOptions["liveIssue"]>> {
  const projects = [];
  for (const binding of bindings) {
    const client = clients(binding.owner);
    const owner = client.owner(binding.owner);
    const project = await owner.project(binding.number).open();
    const fields = [];
    for await (const field of project.fields.list()) fields.push(field);
    const organizationFields = [];
    for await (const field of owner.issueFields.list())
      organizationFields.push(field.name);
    const types = [];
    for await (const type of owner.issueTypes.list()) types.push(type.name);
    const issues = [];
    const labels = new Set<string>();
    const repositories = new Set<string>();
    for await (const card of project.items({ archived: false })) {
      if (card.type !== "issue" || !card.contentRef) continue;
      const coords = parseIssueRef(card.contentRef);
      const repo = client.owner(coords.owner).repo(coords.repo);
      if (!repositories.has(`${coords.owner}/${coords.repo}`)) {
        for await (const label of repo.labels.list()) labels.add(label.name);
        repositories.add(`${coords.owner}/${coords.repo}`);
      }
      const issue = await repo.issue(coords.number).load();
      if (issue.state === "open")
        issues.push({
          ref: issue.ref,
          frontMatter: Object.keys(issueFrontMatter(issue)),
        });
    }
    projects.push({
      name: `${binding.owner}/${String(binding.number)}`,
      fields: [...fields.map((f) => f.name), ...organizationFields],
      types,
      labels: [...labels],
      stages:
        fields
          .find((f) => f.name === "Status" && f.type === "singleSelect")
          ?.options.map((o) => o.name) ?? [],
      issues,
    });
  }
  return projects;
}
export async function validateBoundBlueprintPath(
  path: string,
  clients: ClientFactory,
  bindings: readonly ProjectBinding[],
): Promise<ValidationFinding[]> {
  return validateBlueprintPath(path, {
    checkRequiresIssue: true,
    liveIssue: await liveRequirementFacts(clients, bindings),
  });
}
export { requirementFindings } from "../blueprints/live-checks.js";
