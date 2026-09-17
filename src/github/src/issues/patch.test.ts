import { describe, expect, it } from "vitest";
import { nodeId } from "../refs.js";
import { planDelta, planIssuePatch } from "./patch.js";

const issueId = nodeId("I_1");
const ids = new Map([
  ["vegan", nodeId("L_1")],
  ["needs-photo", nodeId("L_2")],
  ["chef-amara", nodeId("U_1")],
  ["chef-bo", nodeId("U_2")],
]);

describe("planDelta", () => {
  it("array form replaces: computes removals and additions against the current set", () => {
    expect(planDelta(["needs-photo"], ["vegan"])).toEqual({
      remove: ["vegan"],
      add: ["needs-photo"],
    });
  });

  it("delta form only removes what is present and adds what is absent", () => {
    expect(
      planDelta({ add: ["vegan", "needs-photo"], remove: ["vegan", "other"] }, ["vegan"]),
    ).toEqual({ remove: ["vegan"], add: ["needs-photo"] });
  });
});

describe("planIssuePatch", () => {
  it("emits updateIssue for title, body, type and milestone with typed variables", () => {
    const plan = planIssuePatch({
      issueId,
      title: "Green curry",
      body: "Body",
      issueTypeId: nodeId("IT_1"),
      milestoneId: null,
    });
    expect(plan).toEqual([
      {
        kind: "updateIssue",
        input: {
          id: issueId,
          title: "Green curry",
          body: "Body",
          issueTypeId: "IT_1",
          milestoneId: null,
        },
      },
    ]);
  });

  it("orders update, label removals, label additions, assignee removals, additions, fields", () => {
    const plan = planIssuePatch({
      issueId,
      title: "New",
      labels: { delta: ["needs-photo"], current: ["vegan"], ids },
      assignees: { delta: ["chef-bo"], current: ["chef-amara"], ids },
      fields: [{ fieldId: "IFT_1", textValue: "Thai" }],
    });
    expect(plan.map((m) => m.kind)).toEqual([
      "updateIssue",
      "removeLabels",
      "addLabels",
      "removeAssignees",
      "addAssignees",
      "setIssueFieldValue",
    ]);
    expect(plan[1]).toEqual({
      kind: "removeLabels",
      input: { labelableId: issueId, labelIds: ["L_1"] },
    });
    expect(plan[2]).toEqual({
      kind: "addLabels",
      input: { labelableId: issueId, labelIds: ["L_2"] },
    });
    expect(plan[3]).toEqual({
      kind: "removeAssignees",
      input: { assignableId: issueId, assigneeIds: ["U_1"] },
    });
    expect(plan[5]).toEqual({
      kind: "setIssueFieldValue",
      input: { issueId, issueFields: [{ fieldId: "IFT_1", textValue: "Thai" }] },
    });
  });

  it("emits nothing for empty deltas", () => {
    const plan = planIssuePatch({
      issueId,
      labels: { delta: { add: [], remove: [] }, current: ["vegan"], ids },
      assignees: { delta: ["chef-amara"], current: ["chef-amara"], ids },
      fields: [],
    });
    expect(plan).toEqual([]);
  });
});
