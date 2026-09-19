import { describe, expect, it } from "vitest";
import { nodeId } from "../refs.js";
import { planRelations } from "./relations.js";

const issueId = nodeId("I_1");
const parent = nodeId("I_10");
const child = nodeId("I_20");
const blocker = nodeId("I_30");
const pull = nodeId("PR_40");

describe("planRelations", () => {
  it("link parent adds this issue as a sub-issue of the parent, replacing any parent", () => {
    expect(planRelations(issueId, null, { parent }, "link")).toEqual([
      { kind: "addSubIssue", input: { issueId: parent, subIssueId: issueId, replaceParent: true } },
    ]);
  });

  it("link parent null and unlink parent both remove this issue from its current parent", () => {
    const expected = [{ kind: "removeSubIssue", input: { issueId: parent, subIssueId: issueId } }];
    expect(planRelations(issueId, parent, { parent: null }, "link")).toEqual(expected);
    expect(planRelations(issueId, parent, { parent }, "unlink")).toEqual(expected);
    expect(planRelations(issueId, null, { parent: null }, "link")).toEqual([]);
  });

  it("fans out sub-issues, blockers and closing pull requests in both modes", () => {
    const rel = { subIssues: [child], blockedBy: [blocker], closedBy: [pull] };
    expect(planRelations(issueId, null, rel, "link")).toEqual([
      { kind: "addSubIssue", input: { issueId, subIssueId: child } },
      { kind: "addBlockedBy", input: { issueId, blockingIssueId: blocker } },
      { kind: "addCloseIssueReferences", input: { issueId, pullRequestIds: [pull] } },
    ]);
    expect(planRelations(issueId, null, rel, "unlink")).toEqual([
      { kind: "removeSubIssue", input: { issueId, subIssueId: child } },
      { kind: "removeBlockedBy", input: { issueId, blockingIssueId: blocker } },
      { kind: "removeCloseIssueReferences", input: { issueId, pullRequestIds: [pull] } },
    ]);
  });

  it("emits nothing for an empty closedBy list", () => {
    expect(planRelations(issueId, null, { closedBy: [] }, "link")).toEqual([]);
  });
});
