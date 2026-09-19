import { describe, expect, it } from "vitest";
import { github } from "../github.js";
import { defineProject } from "../schema/define.js";
import { ScriptedTransport } from "../testing/scripted-transport.js";
import { lastPage, wireSelectField } from "./fixtures.test-support.js";

const board = defineProject({
  title: "Recipe pipeline",
  fields: { Status: { type: "singleSelect", options: ["Todo", "Done"] } },
});
const summary = (number: number, title = "Recipe pipeline", closed = false) => ({
  id: `PVT_${number}`,
  number,
  title,
  closed,
  public: false,
  url: "u",
});
const conformantFields = () => ({
  node: {
    fields: {
      nodes: [
        wireSelectField("PVTSSF_1", "Status", [
          { id: "s1", name: "Todo" },
          { id: "s2", name: "Done" },
        ]),
      ],
      pageInfo: lastPage,
    },
  },
});

describe("project locator", () => {
  it("ensure creates the project when no open project has the title", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        ProjectsByOwner: () => ({
          repositoryOwner: {
            projectsV2: {
              nodes: [summary(1, "Recipe pipeline", true), summary(2, "Other")],
              pageInfo: lastPage,
            },
          },
        }),
        OwnerLoad: () => ({
          repositoryOwner: { __typename: "Organization", id: "O_1", login: "pantry-labs" },
        }),
        CreateProject: () => ({ createProjectV2: { projectV2: summary(3) } }),
        ProjectFields: conformantFields,
      },
    });
    const gh = github({ auth: { token: "unused" }, transport });
    const project = await gh.owner("pantry-labs").project(board).ensure();
    expect(project.number).toBe(3);
    expect(transport.callsTo("CreateProject")[0]?.input).toEqual({
      input: { ownerId: "O_1", title: "Recipe pipeline" },
    });
    expect(project.lastEnsure.changes).toEqual([{ kind: "unchanged", name: "Status" }]);
  });

  it("throws AmbiguousError when two open projects share the title", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        ProjectsByOwner: () => ({
          repositoryOwner: { projectsV2: { nodes: [summary(1), summary(2)], pageInfo: lastPage } },
        }),
      },
    });
    const gh = github({ auth: { token: "unused" }, transport });
    await expect(gh.owner("pantry-labs").project(board).open()).rejects.toMatchObject({
      code: "AMBIGUOUS",
      candidates: [1, 2],
    });
  });

  it("open verifies the schema without writing", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        ProjectByNumber: () => ({ repositoryOwner: { projectV2: summary(4) } }),
        ProjectFields: () => ({
          node: {
            fields: {
              nodes: [wireSelectField("PVTSSF_1", "Status", [{ id: "s1", name: "Todo" }])],
              pageInfo: lastPage,
            },
          },
        }),
      },
    });
    const gh = github({ auth: { token: "unused" }, transport });
    await expect(
      gh.owner("pantry-labs").project(board, { number: 4 }).open(),
    ).rejects.toMatchObject({
      code: "SCHEMA_MISMATCH",
      gaps: [{ kind: "missing-option", field: "Status", detail: "Done" }],
    });
    expect(transport.calls.every((c) => !c.name.startsWith("Update"))).toBe(true);
  });

  it("opens an undeclared project by number and lists projects", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        ProjectByNumber: () => ({ repositoryOwner: { projectV2: summary(5, "Anything") } }),
        ProjectsByOwner: () => ({
          repositoryOwner: { projectsV2: { nodes: [summary(5, "Anything")], pageInfo: lastPage } },
        }),
      },
    });
    const gh = github({ auth: { token: "unused" }, transport });
    const project = await gh.owner("pantry-labs").project(5).open();
    expect(project.schema.title).toBe("Anything");
    const listed = [];
    for await (const p of gh.owner("pantry-labs").projects()) listed.push(p.number);
    expect(listed).toEqual([5]);
  });
});
