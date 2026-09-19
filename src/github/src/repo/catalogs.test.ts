import { describe, expect, it } from "vitest";
import { github } from "../github.js";
import { ScriptedTransport } from "../testing/scripted-transport.js";
import type { CreateLabelInput, UpdateLabelInput } from "../generated/graphql.js";

describe("repo catalogs (labels and milestones)", () => {
  it("lists labels and ensure creates one", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        OwnerLoad: (vars) => {
          const { login } = vars as { login: string };
          return { repositoryOwner: { __typename: "Organization", id: "O_1", login } };
        },
        RepoLoad: () => ({
          repository: {
            id: "R_1",
            name: "test-repo",
            nameWithOwner: "test-org/test-repo",
            isPrivate: false,
            defaultBranchRef: { name: "main" },
            owner: { login: "test-org" },
          },
        }),
        LabelsList: () => ({
          repository: {
            id: "R_1",
            labels: {
              nodes: [
                { id: "L_1", name: "bug", color: "FF0000", description: "Something is broken" },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        CreateLabel: (vars) => {
          const { input } = vars as { input: CreateLabelInput };
          return {
            createLabel: {
              label: {
                id: "L_2",
                name: input.name,
                color: input.color,
                description: input.description,
              },
            },
          };
        },
      },
    });
    const gh = github({ auth: { token: "unused" }, transport });
    const repo = gh.owner("test-org").repo("test-repo");

    const existing = await repo.labels.list();
    const all = [];
    for await (const label of existing) all.push(label);
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe("bug");

    const report = await repo.labels.ensure({ name: "feature", color: "00FF00" });
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]!.kind).toBe("created");
  });

  it("reports unchanged and updated labels", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        OwnerLoad: (vars) => {
          const { login } = vars as { login: string };
          return { repositoryOwner: { __typename: "Organization", id: "O_1", login } };
        },
        RepoLoad: () => ({
          repository: {
            id: "R_1",
            name: "test-repo",
            nameWithOwner: "test-org/test-repo",
            isPrivate: false,
            defaultBranchRef: { name: "main" },
            owner: { login: "test-org" },
          },
        }),
        LabelsList: () => ({
          repository: {
            id: "R_1",
            labels: {
              nodes: [{ id: "L_1", name: "bug", color: "FF0000", description: "A bug" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        UpdateLabel: (vars) => {
          const { input } = vars as { input: UpdateLabelInput };
          return {
            updateLabel: {
              label: {
                id: input.id,
                name: input.name || "bug",
                color: input.color || "FF0000",
                description: input.description,
              },
            },
          };
        },
      },
    });
    const gh = github({ auth: { token: "unused" }, transport });
    const repo = gh.owner("test-org").repo("test-repo");

    const report1 = await repo.labels.ensure({
      name: "bug",
      color: "FF0000",
      description: "A bug",
    });
    expect(report1.changes).toHaveLength(1);
    expect(report1.changes[0]!.kind).toBe("unchanged");

    const report2 = await repo.labels.ensure({ name: "bug", color: "00FF00" });
    expect(report2.changes).toHaveLength(1);
    expect(report2.changes[0]!.kind).toBe("updated");
  });

  it("lists milestones", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        OwnerLoad: ({ login }) => ({
          repositoryOwner: { __typename: "Organization", id: "O_1", login },
        }),
        RepoLoad: () => ({
          repository: {
            id: "R_1",
            name: "test-repo",
            nameWithOwner: "test-org/test-repo",
            isPrivate: false,
            defaultBranchRef: { name: "main" },
            owner: { login: "test-org" },
          },
        }),
      },
      rest: {
        "GET /repos/{owner}/{repo}/milestones": () => [
          {
            id: 1,
            number: 1,
            title: "v1.0",
            description: "First release",
            due_on: "2024-12-31T00:00:00Z",
            state: "open",
          },
        ],
      },
    });
    const gh = github({ auth: { token: "unused" }, transport });
    const repo = gh.owner("test-org").repo("test-repo");

    const existing = await repo.milestones.list();
    const all = [];
    for await (const m of existing) all.push(m);
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe("v1.0");
    expect(all[0]!.dueOn).toBe("2024-12-31");
  });
});
