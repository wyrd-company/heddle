import { describe, expect, it } from "vitest";
import { github } from "../github.js";
import { defineIssueFields, defineProject } from "../schema/define.js";
import { ScriptedTransport, type Script } from "../testing/scripted-transport.js";
import { GitHubError } from "../transport/errors.js";
import { lastPage, wireField, wireSelectField } from "./fixtures.test-support.js";

const issueFields = defineIssueFields({
  Priority: { type: "singleSelect", options: ["Urgent", "Low"] },
});
const board = defineProject({
  title: "Recipe pipeline",
  fields: {
    Status: { type: "singleSelect", options: ["Idea", "Drafting"] },
    Servings: { type: "number" },
    Priority: { type: "issueField" },
  },
});

const summary = {
  id: "PVT_1",
  number: 3,
  title: "Recipe pipeline",
  closed: false,
  public: false,
  url: "u",
};

const fieldsPage = () => ({
  node: {
    fields: {
      nodes: [
        wireSelectField("PVTSSF_1", "Status", [
          { id: "s1", name: "Idea" },
          { id: "s2", name: "Drafting" },
        ]),
        wireField("PVTF_2", "Servings", "NUMBER"),
        {
          ...wireSelectField("PVTSSF_3", "Priority", []),
          isIssueField: true,
          issueField: {
            __typename: "IssueFieldSingleSelect",
            id: "IFSS_1",
            options: [{ id: "IFSSO_1", name: "Urgent", color: "RED", description: null }],
          },
        },
      ],
      pageInfo: lastPage,
    },
  },
});

const issueItem = () => ({
  node: {
    id: "PVTI_1",
    type: "ISSUE",
    isArchived: false,
    content: {
      __typename: "Issue",
      id: "I_1",
      number: 7,
      title: "Green curry",
      repository: { nameWithOwner: "pantry-labs/recipes" },
    },
    fieldValues: {
      nodes: [
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue",
          name: "Idea",
          optionId: "s1",
          field: { id: "PVTSSF_1", name: "Status" },
        },
        {
          __typename: "ProjectV2ItemIssueFieldValue",
          field: { id: "PVTSSF_3", name: "Priority" },
          issueFieldValue: {
            __typename: "IssueFieldSingleSelectValue",
            name: "Urgent",
            optionId: "IFSSO_1",
          },
        },
      ],
    },
  },
});

const ok = (payload: object) => () => payload;

async function openItem(graphql: Script["graphql"] = {}) {
  const transport = new ScriptedTransport({
    graphql: {
      ProjectByNumber: () => ({ repositoryOwner: { projectV2: summary } }),
      ProjectFields: fieldsPage,
      ItemLoad: issueItem,
      UpdateItemFieldValue: ok({
        updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } },
      }),
      ClearItemFieldValue: ok({
        clearProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } },
      }),
      SetItemIssueFieldValue: ok({ setIssueFieldValue: { issue: { id: "I_1" } } }),
      ...graphql,
    },
  });
  const gh = github({ auth: { token: "unused" }, transport });
  const project = await gh
    .owner("pantry-labs", { issueFields })
    .project(board, { number: 3 })
    .open();
  return { transport, item: project.item("PVTI_1" as never) };
}

describe("item handle", () => {
  it("sets fields in declaration order, one mutation each, routing issue fields to the issue", async () => {
    const { transport, item } = await openItem();
    await item.set({ Status: "Drafting", Servings: null, Priority: "Urgent" });
    expect(transport.calls.map((c) => c.name)).toEqual([
      "ProjectByNumber",
      "ProjectFields",
      "UpdateItemFieldValue",
      "ClearItemFieldValue",
      "ItemLoad",
      "SetItemIssueFieldValue",
    ]);
    expect(transport.callsTo("UpdateItemFieldValue")[0]?.input).toEqual({
      input: {
        projectId: "PVT_1",
        itemId: "PVTI_1",
        fieldId: "PVTSSF_1",
        value: { singleSelectOptionId: "s2" },
      },
    });
    expect(transport.callsTo("SetItemIssueFieldValue")[0]?.input).toEqual({
      input: {
        issueId: "I_1",
        issueFields: [{ fieldId: "IFSS_1", singleSelectOptionId: "IFSSO_1" }],
      },
    });
  });

  it("stops at the first failing field", async () => {
    const { transport, item } = await openItem({
      ClearItemFieldValue: () => {
        throw new GitHubError("VALIDATION", "cannot clear");
      },
    });
    await expect(
      item.set({ Status: "Drafting", Servings: null, Priority: "Urgent" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(transport.callsTo("UpdateItemFieldValue")).toHaveLength(1);
    expect(transport.callsTo("SetItemIssueFieldValue")).toHaveLength(0);
  });

  it("rejects an unknown field before any mutation", async () => {
    const { transport, item } = await openItem();
    await expect(item.set({ Ghost: "x" } as never)).rejects.toMatchObject({
      code: "SCHEMA_MISMATCH",
    });
    expect(transport.callsTo("UpdateItemFieldValue")).toHaveLength(0);
  });

  it("reads a snapshot shaped by the schema", async () => {
    const { item } = await openItem();
    expect(await item.get()).toEqual({ Status: "Idea", Servings: null, Priority: "Urgent" });
    expect(await item.load()).toMatchObject({
      type: "issue",
      contentRef: "pantry-labs/recipes#7",
      title: "Green curry",
    });
  });

  it("refuses to edit a non-draft item", async () => {
    const { item } = await openItem();
    await expect(item.editDraft({ title: "x" })).rejects.toMatchObject({ code: "NOT_DRAFT" });
  });
});
