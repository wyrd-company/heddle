import { describe, expect, it } from "vitest";
import { github } from "../github.js";
import { ScriptedTransport } from "../testing/scripted-transport.js";

const lastPage = { hasNextPage: false, endCursor: null };

const issueNode = (overrides: Record<string, unknown> = {}) => ({
  __typename: "Issue",
  id: "I_1",
  number: 1,
  title: "Green curry",
  body: "Body",
  state: "OPEN",
  stateReason: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  url: "https://example.invalid/1",
  repository: { name: "recipes", owner: { login: "pantry-labs" } },
  issueType: { name: "Recipe" },
  milestone: null,
  labels: { nodes: [{ id: "L_1", name: "vegan", color: "0e8a16", description: null }] },
  assignees: { nodes: [{ login: "chef-amara" }] },
  parent: {
    id: "I_10",
    number: 10,
    repository: { name: "recipes", owner: { login: "pantry-labs" } },
  },
  subIssues: { nodes: [], pageInfo: lastPage },
  blockedBy: { nodes: [], pageInfo: lastPage },
  blocking: { nodes: [], pageInfo: lastPage },
  duplicateOf: {
    id: "I_12",
    number: 12,
    repository: { name: "recipes", owner: { login: "pantry-labs" } },
  },
  closedByPullRequestsReferences: { nodes: [], pageInfo: lastPage },
  issueFieldValues: {
    nodes: [
      {
        __typename: "IssueFieldSingleSelectValue",
        field: { name: "Priority" },
        optionName: "High",
      },
    ],
  },
  ...overrides,
});

const ok = (payload: Record<string, unknown>) => () => payload;

describe("Issue handle (scripted)", () => {
  it("load parses relationships, labels, assignees and fields by name", async () => {
    const transport = new ScriptedTransport({
      graphql: { IssueLoad: () => ({ repository: { issue: issueNode() } }) },
    });
    const gh = github({ auth: { token: "unused" }, transport });
    const issue = gh
      .owner("pantry-labs", {
        issueFields: { Priority: { type: "singleSelect", options: ["High", "Low"] } },
      })
      .repo("recipes")
      .issue(1);
    const data = await issue.load();
    expect(data.ref).toBe("pantry-labs/recipes#1");
    expect(data.type).toBe("Recipe");
    expect(data.parent).toBe("pantry-labs/recipes#10");
    expect(data.duplicateOf).toBe("pantry-labs/recipes#12");
    expect(data.labels.map((l) => l.name)).toEqual(["vegan"]);
    expect(data.assignees).toEqual(["chef-amara"]);
    expect(data.fields).toEqual({ Priority: "High" });
    expect(await issue.id()).toBe("I_1");
  });

  it("set runs updateIssue, then label removals and additions, then field writes", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        IssueLoad: () => ({ repository: { issue: issueNode() } }),
        LabelsList: () => ({
          repository: {
            id: "R_1",
            labels: {
              nodes: [
                { id: "L_1", name: "vegan", color: "0e8a16", description: null },
                { id: "L_2", name: "needs-photo", color: "fbca04", description: null },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        IssueFieldsList: () => ({
          organization: {
            issueFields: {
              nodes: [
                {
                  __typename: "IssueFieldText",
                  id: "IFT_1",
                  name: "Notes",
                  dataType: "TEXT",
                  description: null,
                  visibility: "ALL",
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        UpdateIssue: ok({ updateIssue: { issue: { id: "I_1" } } }),
        RemoveLabelsFromLabelable: ok({
          removeLabelsFromLabelable: { labelable: { __typename: "Issue", id: "I_1" } },
        }),
        AddLabelsToLabelable: ok({
          addLabelsToLabelable: { labelable: { __typename: "Issue", id: "I_1" } },
        }),
        SetIssueFieldValue: ok({ setIssueFieldValue: { issue: { id: "I_1" } } }),
      },
    });
    const gh = github({ auth: { token: "unused" }, transport });
    const issue = gh
      .owner("pantry-labs", { issueFields: { Notes: { type: "text" } } })
      .repo("recipes")
      .issue(1);

    await issue.set({
      title: "Red curry",
      labels: ["needs-photo"],
      fields: { Notes: "Less chilli" },
    });

    const mutations = transport.calls.filter(
      (c) => c.kind === "graphql" && /^(Update|Remove|Add|Set)/.test(c.name),
    );
    expect(mutations.map((c) => c.name)).toEqual([
      "UpdateIssue",
      "RemoveLabelsFromLabelable",
      "AddLabelsToLabelable",
      "SetIssueFieldValue",
    ]);
    expect(mutations[0]?.input).toEqual({ input: { id: "I_1", title: "Red curry" } });
    expect(mutations[1]?.input).toEqual({ input: { labelableId: "I_1", labelIds: ["L_1"] } });
    expect(mutations[2]?.input).toEqual({ input: { labelableId: "I_1", labelIds: ["L_2"] } });
    expect(mutations[3]?.input).toEqual({
      input: { issueId: "I_1", issueFields: [{ fieldId: "IFT_1", textValue: "Less chilli" }] },
    });
  });

  it("link resolves refs to ids and clears the parent through the current parent", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        IssueLoad: () => ({ repository: { issue: issueNode() } }),
        IssueId: ({ number }) => ({
          repository: { issueOrPullRequest: { __typename: "Issue", id: `I_${number}` } },
        }),
        AddBlockedBy: ok({ addBlockedBy: { issue: { id: "I_1" } } }),
        RemoveSubIssue: ok({ removeSubIssue: { issue: { id: "I_10" }, subIssue: { id: "I_1" } } }),
      },
    });
    const gh = github({ auth: { token: "unused" }, transport });
    const issue = gh.owner("pantry-labs").repo("recipes").issue(1);

    await issue.link({ parent: null, blockedBy: ["pantry-labs/recipes#40"] });

    expect(transport.callsTo("RemoveSubIssue")[0]?.input).toEqual({
      input: { issueId: "I_10", subIssueId: "I_1" },
    });
    expect(transport.callsTo("AddBlockedBy")[0]?.input).toEqual({
      input: { issueId: "I_1", blockingIssueId: "I_40" },
    });
  });
});
