import { describe, expect, it } from "vitest";
import { github } from "../github.js";
import { defineProject } from "../schema/define.js";
import { ScriptedTransport } from "../testing/scripted-transport.js";
import { lastPage, wireField, wireSelectField } from "./fixtures.test-support.js";

const summary = {
  id: "PVT_1",
  number: 3,
  title: "Recipe pipeline",
  closed: false,
  public: false,
  url: "u",
};

const board = defineProject({
  title: "Recipe pipeline",
  fields: {
    Status: {
      type: "singleSelect",
      options: ["Todo", "Drafting", { name: "Done", color: "GREEN" }],
    },
    Servings: { type: "number" },
    Priority: { type: "issueField" },
  },
});

describe("project fields catalog", () => {
  it("ensure creates missing fields, appends options, links org fields, reports drift", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        ProjectsByOwner: () => ({
          repositoryOwner: { projectsV2: { nodes: [summary], pageInfo: lastPage } },
        }),
        ProjectFields: () => ({
          node: {
            fields: {
              nodes: [
                wireField("PVTF_0", "Title", "TITLE"),
                wireSelectField("PVTSSF_1", "Status", [
                  { id: "s1", name: "Todo" },
                  { id: "s2", name: "Done" },
                ]),
                wireField("PVTF_9", "Cuisine", "TEXT"),
              ],
              pageInfo: lastPage,
            },
          },
        }),
        UpdateProjectField: ({ input }) => ({
          updateProjectV2Field: {
            projectV2Field: wireSelectField(
              "PVTSSF_1",
              "Status",
              (
                input as { singleSelectOptions: { id?: string; name: string }[] }
              ).singleSelectOptions.map((o, i) => ({ id: o.id ?? `new${i}`, name: o.name })),
            ),
          },
        }),
        CreateProjectField: ({ input }) => ({
          createProjectV2Field: {
            projectV2Field: wireField("PVTF_2", (input as { name: string }).name, "NUMBER"),
          },
        }),
        OwnerIssueFieldIds: () => ({
          organization: {
            issueFields: {
              nodes: [{ __typename: "IssueFieldSingleSelect", id: "IFSS_1", name: "Priority" }],
            },
          },
        }),
        CreateProjectIssueField: () => ({
          createProjectV2IssueField: {
            projectV2Field: {
              ...wireSelectField("PVTSSF_3", "Priority", []),
              isIssueField: true,
              issueField: { __typename: "IssueFieldSingleSelect", id: "IFSS_1", options: [] },
            },
          },
        }),
      },
    });
    const gh = github({ auth: { token: "unused" }, transport });
    const project = await gh.owner("pantry-labs").project(board).ensure();

    expect(project.lastEnsure.changes).toEqual([
      { kind: "option-added", field: "Status", option: "Drafting" },
      { kind: "option-updated", field: "Status", option: "Done", properties: ["color"] },
      { kind: "updated", name: "Status", properties: ["options"] },
      { kind: "created", name: "Servings" },
      { kind: "created", name: "Priority" },
      { kind: "field-unmanaged", field: "Cuisine" },
    ]);
    expect(transport.callsTo("UpdateProjectField")[0]?.input).toEqual({
      input: {
        fieldId: "PVTSSF_1",
        singleSelectOptions: [
          { id: "s1", name: "Todo", color: "GRAY", description: "" },
          { name: "Drafting", color: "GRAY", description: "" },
          { id: "s2", name: "Done", color: "GREEN", description: "" },
        ],
      },
    });
    expect(transport.callsTo("CreateProjectField")[0]?.input).toEqual({
      input: { projectId: "PVT_1", name: "Servings", dataType: "NUMBER" },
    });
    expect(transport.callsTo("CreateProjectIssueField")[0]?.input).toEqual({
      input: { projectId: "PVT_1", issueFieldId: "IFSS_1" },
    });
  });

  it("creates iteration fields with three default iterations", async () => {
    const weekly = defineProject({
      title: "Weekly",
      fields: { Week: { type: "iteration", startDate: "2026-10-05", duration: 7 } },
    });
    const transport = new ScriptedTransport({
      graphql: {
        ProjectsByOwner: () => ({
          repositoryOwner: {
            projectsV2: { nodes: [{ ...summary, title: "Weekly" }], pageInfo: lastPage },
          },
        }),
        ProjectFields: () => ({ node: { fields: { nodes: [], pageInfo: lastPage } } }),
        CreateProjectField: () => ({
          createProjectV2Field: {
            projectV2Field: {
              __typename: "ProjectV2IterationField",
              id: "PVTIF_1",
              name: "Week",
              dataType: "ITERATION",
              isIssueField: false,
              configuration: { duration: 7, iterations: [], completedIterations: [] },
            },
          },
        }),
      },
    });
    const gh = github({ auth: { token: "unused" }, transport });
    await gh.owner("pantry-labs").project(weekly).ensure();
    expect(transport.callsTo("CreateProjectField")[0]?.input).toEqual({
      input: {
        projectId: "PVT_1",
        name: "Week",
        dataType: "ITERATION",
        iterationConfiguration: {
          startDate: "2026-10-05",
          duration: 7,
          iterations: [
            { title: "Iteration 1", startDate: "2026-10-05", duration: 7 },
            { title: "Iteration 2", startDate: "2026-10-12", duration: 7 },
            { title: "Iteration 3", startDate: "2026-10-19", duration: 7 },
          ],
        },
      },
    });
  });
});
