// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import type { Blueprint } from "../blueprints/types.js";
import type { GitHub } from "../github/src/github.js";
import type { Project } from "../github/src/projects/project.js";
import type {
  ProjectSchema,
  IssueFieldSchema,
} from "../github/src/schema/types.js";
import { GitHubError } from "../github/src/transport/errors.js";
import type { ProjectBinding } from "./config.js";
export type BoundProject = Project<ProjectSchema, IssueFieldSchema>;
export function stages(blueprints: readonly Blueprint[]): string[] {
  return [
    ...new Set(
      blueprints.flatMap((blueprint) =>
        Object.entries(blueprint.nodes)
          .filter(([, node]) => node.stage === true)
          .map(([id]) => id),
      ),
    ),
  ];
}
export async function reconcileProject(
  client: GitHub,
  binding: ProjectBinding,
  blueprints: readonly Blueprint[],
  attention: (message: string) => void,
): Promise<BoundProject> {
  const owner = client.owner<IssueFieldSchema>(binding.owner);
  const project = await owner.project(binding.number).open();
  const fields: ProjectSchema["fields"] = {
    Status: { type: "singleSelect", options: stages(blueprints) },
    Paused: { type: "singleSelect", options: ["Yes", "No"] },
  };
  const required = new Set(
    blueprints.flatMap(
      (b) =>
        (b.requires?.["issue"] as { fields?: string[] } | undefined)?.fields ??
        [],
    ),
  );
  const unresolved: string[] = [];
  for (const name of required) {
    if (name in fields || (await project.fields.find(name))) continue;
    if (await owner.issueFields.find(name))
      fields[name] = { type: "issueField" };
    else unresolved.push(`Required issue field does not exist: ${name}`);
  }
  // Existing Status options stay first; new blueprint stages append in authored order.
  const status = await project.fields.find("Status");
  if (status?.type === "singleSelect")
    fields["Status"] = {
      type: "singleSelect",
      options: [
        ...new Set([
          ...status.options.map((o) => o.name),
          ...stages(blueprints),
        ]),
      ],
    };
  const ensured = await owner
    .project(
      { title: project.schema.title, fields },
      { number: binding.number },
    )
    .ensure();
  for (const change of ensured.lastEnsure.changes)
    if (change.kind === "type-mismatch")
      unresolved.push(`Project schema drift: ${JSON.stringify(change)}`);
  if (unresolved.length) {
    for (const message of unresolved) attention(message);
    throw new GitHubError(
      "SCHEMA_MISMATCH",
      "Project reconciliation requires attention",
    );
  }
  // An undeclared handle retains every card field in snapshots.
  return owner.project(binding.number).open();
}
