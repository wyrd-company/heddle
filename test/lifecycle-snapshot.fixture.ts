// ---
// relationships:
//   verifies: github-binding-and-intake
// ---
import type { IssueSnapshot } from "../src/index.js";
export const issue: IssueSnapshot = {
  id: "item-1" as IssueSnapshot["id"],
  ref: "sample/collection#1",
  number: 1,
  title: "Inspect a book",
  body: "A collection item.",
  state: "open",
  stateReason: null,
  type: "Collection request",
  milestone: null,
  labels: [],
  assignees: [],
  fields: {},
  parent: null,
  subIssues: [],
  blockedBy: [],
  blocking: [],
  duplicateOf: null,
  closedBy: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  url: "https://example.com/sample/collection/issues/1",
  repository: "sample/collection",
  project: {
    id: "project-1",
    owner: "sample",
    number: 1,
    itemId: "card-1",
    fields: {},
  },
  frontMatter: {},
};
