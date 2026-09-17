// ---
// relationships:
//   verifies: github-client
// ---
import { print } from "graphql";
import { describe, expect, it } from "vitest";
import { github } from "../github.js";
import { ScriptedTransport } from "../testing/scripted-transport.js";
import { IssueClosedByPageDocument, IssueLoadDocument } from "./documents.js";

const lastPage = { hasNextPage: false, endCursor: null };
const relation = (number: number) => ({
  id: `I_${String(number)}`,
  number,
  repository: { name: "records", owner: { login: "sample-owner" } },
});
const issueNode = (overrides: Record<string, unknown> = {}) => ({
  __typename: "Issue",
  id: "I_1",
  number: 1,
  title: "Example",
  body: "Body",
  state: "OPEN",
  stateReason: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  url: "https://example.invalid/1",
  repository: { name: "records", owner: { login: "sample-owner" } },
  issueType: null,
  milestone: null,
  labels: { nodes: [] },
  assignees: { nodes: [] },
  parent: null,
  subIssues: { nodes: [], pageInfo: lastPage },
  blockedBy: { nodes: [], pageInfo: lastPage },
  blocking: { nodes: [], pageInfo: lastPage },
  duplicateOf: null,
  closedByPullRequestsReferences: { nodes: [], pageInfo: lastPage },
  issueFieldValues: { nodes: [] },
  ...overrides,
});
const relationshipCases = [
  { field: "subIssues", result: "subIssues", operation: "IssueSubIssuesPage" },
  { field: "blockedBy", result: "blockedBy", operation: "IssueBlockedByPage" },
  { field: "blocking", result: "blocking", operation: "IssueBlockingPage" },
  { field: "closedByPullRequestsReferences", result: "closedBy", operation: "IssueClosedByPage" },
] as const;

describe("issue relationship pagination", () => {
  it("includes closed pull requests in both initial and continuation documents", () => {
    expect(print(IssueLoadDocument)).toContain("includeClosedPrs: true");
    expect(print(IssueClosedByPageDocument)).toContain("includeClosedPrs: true");
  });

  it.each(relationshipCases)(
    "follows every $field cursor through its terminal page",
    async ({ field, result, operation }) => {
      const firstCursor = `${field}-page-1`;
      const secondCursor = `${field}-page-2`;
      const transport = new ScriptedTransport({
        graphql: {
          IssueLoad: ({ relationshipPageSize }) => {
            expect(relationshipPageSize).toBe(2);
            return {
              repository: {
                issue: issueNode({
                  [field]: {
                    nodes: [relation(20)],
                    pageInfo: { hasNextPage: true, endCursor: firstCursor },
                  },
                }),
              },
            };
          },
          [operation]: [
            ({ id, first, after }) => {
              expect({ id, first, after }).toEqual({ id: "I_1", first: 2, after: firstCursor });
              return {
                node: {
                  __typename: "Issue",
                  [field]: {
                    nodes: [relation(21)],
                    pageInfo: { hasNextPage: true, endCursor: secondCursor },
                  },
                },
              };
            },
            ({ id, first, after }) => {
              expect({ id, first, after }).toEqual({ id: "I_1", first: 2, after: secondCursor });
              return {
                node: {
                  __typename: "Issue",
                  [field]: { nodes: [relation(22)], pageInfo: lastPage },
                },
              };
            },
          ],
        },
      });
      const issue = github({ auth: { token: "unused" }, transport, relationshipPageSize: 2 })
        .owner("sample-owner")
        .repo("records")
        .issue(1);

      const data = await issue.load();

      expect(data[result]).toEqual([
        "sample-owner/records#20",
        "sample-owner/records#21",
        "sample-owner/records#22",
      ]);
      expect(transport.callsTo(operation)).toHaveLength(2);
    },
  );

  it.each(relationshipCases)(
    "surfaces a later $field page failure without returning a partial snapshot",
    async ({ field, operation }) => {
      const transport = new ScriptedTransport({
        graphql: {
          IssueLoad: () => ({
            repository: {
              issue: issueNode({
                [field]: {
                  nodes: [relation(20)],
                  pageInfo: { hasNextPage: true, endCursor: `${field}-page-1` },
                },
              }),
            },
          }),
          [operation]: () => {
            throw new Error(`${field} continuation failed`);
          },
        },
      });
      const issue = github({ auth: { token: "unused" }, transport })
        .owner("sample-owner")
        .repo("records")
        .issue(1);

      await expect(issue.load()).rejects.toThrow(`${field} continuation failed`);
      expect(transport.callsTo(operation)).toHaveLength(1);
    },
  );

  it("completes relationship pages for issue-list snapshots", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        IssueList: () => ({
          repository: {
            issues: {
              nodes: [
                issueNode({
                  subIssues: {
                    nodes: [relation(20)],
                    pageInfo: { hasNextPage: true, endCursor: "sub-page" },
                  },
                }),
              ],
              pageInfo: lastPage,
            },
          },
        }),
        IssueSubIssuesPage: () => ({
          node: { __typename: "Issue", subIssues: { nodes: [relation(21)], pageInfo: lastPage } },
        }),
      },
    });
    const issues = github({ auth: { token: "unused" }, transport })
      .owner("sample-owner")
      .repo("records").issues;
    const snapshots = [];
    for await (const snapshot of issues.list()) snapshots.push(snapshot);

    expect(snapshots[0]?.subIssues).toEqual(["sample-owner/records#20", "sample-owner/records#21"]);
  });
});
