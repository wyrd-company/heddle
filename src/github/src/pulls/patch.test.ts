import { describe, expect, it } from "vitest";
import { nodeId } from "../refs.js";
import { planPullPatch } from "./patch.js";

describe("planPullPatch", () => {
  const pullId = nodeId("PR_1");
  const labelIds = new Map([
    ["vegan", nodeId("L_1")],
    ["needs-photo", nodeId("L_2")],
  ]);
  const assigneeIds = new Map([
    ["chef-amara", nodeId("U_1")],
    ["sous-benji", nodeId("U_2")],
  ]);

  it("plans title, body, base and milestone in one update", () => {
    const plan = planPullPatch(
      { title: "Green curry", body: "Draft", base: "main", milestone: "Autumn issue" },
      { pullId, milestoneId: nodeId("M_1") },
    );
    expect(plan).toEqual([
      {
        kind: "updatePullRequest",
        input: {
          pullRequestId: pullId,
          title: "Green curry",
          body: "Draft",
          baseRefName: "main",
          milestoneId: "M_1",
        },
      },
    ]);
  });

  it("clears the milestone with null and plans nothing for an empty patch", () => {
    expect(planPullPatch({ milestone: null }, { pullId })).toEqual([
      { kind: "updatePullRequest", input: { pullRequestId: pullId, milestoneId: null } },
    ]);
    expect(planPullPatch({}, { pullId })).toEqual([]);
  });

  it("plans the draft toggle after the update", () => {
    expect(planPullPatch({ draft: true, title: "x" }, { pullId }).map((m) => m.kind)).toEqual([
      "updatePullRequest",
      "convertToDraft",
    ]);
    expect(planPullPatch({ draft: false }, { pullId })).toEqual([
      { kind: "markReadyForReview", input: { pullRequestId: pullId } },
    ]);
  });

  it("replaces labels from an array against the current set", () => {
    const plan = planPullPatch(
      { labels: ["vegan"] },
      { pullId, labelIds, current: { labels: ["needs-photo"], assignees: [] } },
    );
    expect(plan).toEqual([
      { kind: "removeLabels", input: { labelableId: pullId, labelIds: ["L_2"] } },
      { kind: "addLabels", input: { labelableId: pullId, labelIds: ["L_1"] } },
    ]);
  });

  it("applies label and assignee deltas", () => {
    const plan = planPullPatch(
      {
        labels: { add: ["vegan"], remove: ["needs-photo"] },
        assignees: { add: ["chef-amara"], remove: ["sous-benji"] },
      },
      { pullId, labelIds, assigneeIds },
    );
    expect(plan).toEqual([
      { kind: "removeLabels", input: { labelableId: pullId, labelIds: ["L_2"] } },
      { kind: "addLabels", input: { labelableId: pullId, labelIds: ["L_1"] } },
      { kind: "removeAssignees", input: { assignableId: pullId, assigneeIds: ["U_2"] } },
      { kind: "addAssignees", input: { assignableId: pullId, assigneeIds: ["U_1"] } },
    ]);
  });
});
