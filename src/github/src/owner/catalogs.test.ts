import { describe, expect, it } from "vitest";
import { github } from "../github.js";
import { ScriptedTransport } from "../testing/scripted-transport.js";
import type { CreateIssueTypeInput, UpdateIssueTypeInput } from "../generated/graphql.js";

describe("owner catalogs (issue types and fields)", () => {
  it("lists issue types and ensure creates one", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        OwnerLoad: (vars) => {
          const { login } = vars as { login: string };
          return { repositoryOwner: { __typename: "Organization", id: "O_1", login } };
        },
        IssueTypesList: () => ({
          organization: {
            issueTypes: {
              nodes: [
                { id: "IT_1", name: "Bug", description: "A bug", color: "RED", isEnabled: true },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        CreateIssueType: (vars) => {
          const { input } = vars as { input: CreateIssueTypeInput };
          return {
            createIssueType: {
              issueType: {
                id: "IT_2",
                name: input.name,
                description: input.description,
                color: input.color,
                isEnabled: input.isEnabled,
              },
            },
          };
        },
      },
    });
    const gh = github({ auth: { token: "unused" }, transport });
    const owner = gh.owner("test-org");

    const existing = await owner.issueTypes.list();
    const all = [];
    for await (const it of existing) all.push(it);
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe("Bug");

    const report = await owner.issueTypes.ensure({ name: "Feature", color: "BLUE", enabled: true });
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]!.kind).toBe("created");
  });

  it("reports unchanged and updated issue types", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        OwnerLoad: (vars) => {
          const { login } = vars as { login: string };
          return { repositoryOwner: { __typename: "Organization", id: "O_1", login } };
        },
        IssueTypesList: () => ({
          organization: {
            issueTypes: {
              nodes: [
                { id: "IT_1", name: "Bug", description: "A bug", color: "RED", isEnabled: true },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        UpdateIssueType: (vars) => {
          const { input } = vars as { input: UpdateIssueTypeInput };
          return {
            updateIssueType: {
              issueType: {
                id: input.issueTypeId,
                name: input.name || "Bug",
                description: input.description,
                color: input.color || "RED",
                isEnabled: input.isEnabled ?? true,
              },
            },
          };
        },
      },
    });
    const gh = github({ auth: { token: "unused" }, transport });
    const owner = gh.owner("test-org");

    const report1 = await owner.issueTypes.ensure({ name: "Bug", color: "RED", enabled: true });
    expect(report1.changes).toHaveLength(1);
    expect(report1.changes[0]!.kind).toBe("unchanged");

    const report2 = await owner.issueTypes.ensure({ name: "Bug", color: "BLUE", enabled: true });
    expect(report2.changes).toHaveLength(1);
    expect(report2.changes[0]!.kind).toBe("updated");
  });
});
