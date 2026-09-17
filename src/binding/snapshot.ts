// ---
// relationships:
//   implements: github-binding-and-intake
// ---
import { parse } from "yaml";
import type { IssueData } from "../github/src/issues/issue.js";
import type { IssueFieldSchema } from "../github/src/schema/types.js";
import type { Data } from "../engine/types.js";

export interface IssueSnapshot extends IssueData<IssueFieldSchema> {
  repository: string;
  project: {
    id: string;
    owner: string;
    number: number;
    itemId: string;
    fields: Data;
  };
  frontMatter: Data;
}
export function frontMatter(body: string): Data {
  const match = /^\s*<!--\s*\r?\n---\r?\n([\s\S]*?)\r?\n---\s*\r?\n?-->/u.exec(
    body,
  );
  if (!match) return {};
  const value: unknown = parse(match[1] ?? "");
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Issue front matter must be a YAML mapping");
  return value as Data;
}
export function snapshot(
  issue: IssueData<IssueFieldSchema>,
  project: IssueSnapshot["project"],
): IssueSnapshot {
  return {
    ...issue,
    repository: issue.ref.slice(0, issue.ref.lastIndexOf("#")),
    project,
    frontMatter: frontMatter(issue.body),
  };
}
