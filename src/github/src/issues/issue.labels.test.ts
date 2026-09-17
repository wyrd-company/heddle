// ---
// relationships:
//   verifies: github-client
// ---
import { describe, expect, it } from "vitest";
import { github } from "../github.js";
import { ScriptedTransport } from "../testing/scripted-transport.js";

const lastPage = { hasNextPage: false, endCursor: null };
const label = (number: number) => ({
  id: `L_${String(number)}`,
  name: `sample-${String(number)}`,
  color: "0e8a16",
  description: null,
});
const issueNode = (labels: Record<string, unknown>) => ({
  __typename: "Issue",
  id: "I_1",
  number: 1,
  title: "Sample record",
  body: "Body",
  state: "OPEN",
  stateReason: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  url: "https://example.invalid/1",
  repository: { name: "records", owner: { login: "sample-owner" } },
  issueType: null,
  milestone: null,
  labels,
  assignees: { nodes: [] },
  parent: null,
  subIssues: { nodes: [], pageInfo: lastPage },
  blockedBy: { nodes: [], pageInfo: lastPage },
  blocking: { nodes: [], pageInfo: lastPage },
  duplicateOf: null,
  closedByPullRequestsReferences: { nodes: [], pageInfo: lastPage },
  issueFieldValues: { nodes: [] },
});
const firstPage = { nodes: [label(1)], pageInfo: { hasNextPage: true, endCursor: "label-page-1" } };
const issueHandle = (transport: ScriptedTransport) =>
  github({ auth: { token: "unused" }, transport, labelPageSize: 1 })
    .owner("sample-owner")
    .repo("records")
    .issue(1);

describe("issue label pagination", () => {
  it("follows distinct cursors through two nonempty continuation pages", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        IssueLoad: ({ labelPageSize }) => {
          expect(labelPageSize).toBe(1);
          return { repository: { issue: issueNode(firstPage) } };
        },
        IssueLabelsPage: [
          ({ id, first, after }) => {
            expect({ id, first, after }).toEqual({ id: "I_1", first: 1, after: "label-page-1" });
            return {
              node: {
                __typename: "Issue",
                labels: {
                  nodes: [label(2)],
                  pageInfo: { hasNextPage: true, endCursor: "label-page-2" },
                },
              },
            };
          },
          ({ id, first, after }) => {
            expect({ id, first, after }).toEqual({ id: "I_1", first: 1, after: "label-page-2" });
            return {
              node: { __typename: "Issue", labels: { nodes: [label(3)], pageInfo: lastPage } },
            };
          },
        ],
      },
    });

    const loaded = await issueHandle(transport).load();

    expect(loaded.labels).toEqual([label(1), label(2), label(3)]);
    expect(transport.callsTo("IssueLabelsPage")).toHaveLength(2);
  });

  it("completes labels for issue-list snapshots", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        IssueList: ({ labelPageSize }) => {
          expect(labelPageSize).toBe(1);
          return { repository: { issues: { nodes: [issueNode(firstPage)], pageInfo: lastPage } } };
        },
        IssueLabelsPage: () => ({
          node: { __typename: "Issue", labels: { nodes: [label(2)], pageInfo: lastPage } },
        }),
      },
    });
    const snapshots = [];
    for await (const snapshot of github({ auth: { token: "unused" }, transport, labelPageSize: 1 })
      .owner("sample-owner")
      .repo("records")
      .issues.list())
      snapshots.push(snapshot);

    expect(snapshots[0]?.labels).toEqual([label(1), label(2)]);
  });

  it.each([
    {
      name: "missing",
      pageInfo: { hasNextPage: true, endCursor: null },
      error: "missing cursor for a non-terminal page",
      continuationCalls: 0,
    },
    {
      name: "repeated",
      pageInfo: { hasNextPage: true, endCursor: "label-page-1" },
      error: "cursor did not advance from label-page-1",
      continuationCalls: 1,
    },
  ])("refuses a $name continuation cursor", async ({ pageInfo, error, continuationCalls }) => {
    let continuation = 0;
    const transport = new ScriptedTransport({
      graphql: {
        IssueLoad: () => ({ repository: { issue: issueNode({ nodes: [label(1)], pageInfo }) } }),
        IssueLabelsPage: () => {
          continuation++;
          return {
            node: {
              __typename: "Issue",
              labels: { nodes: [label(2)], pageInfo: continuation === 1 ? pageInfo : lastPage },
            },
          };
        },
      },
    });

    await expect(issueHandle(transport).load()).rejects.toThrow(error);
    expect(transport.callsTo("IssueLabelsPage")).toHaveLength(continuationCalls);
  });

  it("does not begin a mutation when a later label page fails", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        IssueLoad: () => ({ repository: { issue: issueNode(firstPage) } }),
        IssueLabelsPage: () => {
          throw new Error("label continuation failed");
        },
        AddLabelsToLabelable: () => {
          throw new Error("unexpected mutation");
        },
        UpdateIssue: () => {
          throw new Error("unexpected mutation");
        },
      },
    });

    await expect(
      issueHandle(transport).set({ title: "Changed record", labels: { add: ["sample-2"] } }),
    ).rejects.toThrow("label continuation failed");
    expect(transport.callsTo("UpdateIssue")).toHaveLength(0);
    expect(transport.callsTo("AddLabelsToLabelable")).toHaveLength(0);
  });

  it.each([
    { name: "add", delta: { add: ["sample-3"] }, removed: [] as string[], added: ["L_3"] },
    { name: "remove", delta: { remove: ["sample-2"] }, removed: ["L_2"], added: [] as string[] },
    { name: "replacement", delta: ["sample-1", "sample-3"], removed: ["L_2"], added: ["L_3"] },
  ])("plans $name from the complete current label set", async ({ delta, removed, added }) => {
    const transport = new ScriptedTransport({
      graphql: {
        IssueLoad: () => ({ repository: { issue: issueNode(firstPage) } }),
        IssueLabelsPage: () => ({
          node: { __typename: "Issue", labels: { nodes: [label(2)], pageInfo: lastPage } },
        }),
        LabelsList: () => ({
          repository: {
            id: "R_1",
            labels: { nodes: [label(1), label(2), label(3)], pageInfo: lastPage },
          },
        }),
        RemoveLabelsFromLabelable: () => ({
          removeLabelsFromLabelable: { labelable: { __typename: "Issue", id: "I_1" } },
        }),
        AddLabelsToLabelable: () => ({
          addLabelsToLabelable: { labelable: { __typename: "Issue", id: "I_1" } },
        }),
      },
    });

    await issueHandle(transport).set({ labels: delta });

    expect(
      transport.callsTo("RemoveLabelsFromLabelable").map((call) => call.input["input"]),
    ).toEqual(removed.length ? [{ labelableId: "I_1", labelIds: removed }] : []);
    expect(transport.callsTo("AddLabelsToLabelable").map((call) => call.input["input"])).toEqual(
      added.length ? [{ labelableId: "I_1", labelIds: added }] : [],
    );
  });
});
