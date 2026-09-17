import { describe, expect, it } from "vitest";
import { github } from "../github.js";
import { ScriptedTransport } from "../testing/scripted-transport.js";
import { GitHubError } from "../transport/errors.js";

describe("owner and repo handles", () => {
  it("loads an owner once and caches it", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        OwnerLoad: ({ login }) => ({
          repositoryOwner: { __typename: "Organization", id: "O_1", login },
        }),
      },
    });
    const gh = github({ auth: { token: "unused" }, transport });
    const pantry = gh.owner("pantry-labs");
    expect(await pantry.load()).toEqual({ id: "O_1", login: "pantry-labs", kind: "organization" });
    await pantry.load();
    expect(transport.callsTo("OwnerLoad")).toHaveLength(1);
    expect(transport.calls[0]?.input).toEqual({ login: "pantry-labs" });
  });

  it("loads a repository and reports a missing one as NOT_FOUND", async () => {
    const transport = new ScriptedTransport({
      graphql: {
        RepoLoad: [
          ({ owner, name }) => ({
            repository: {
              id: "R_1",
              name,
              nameWithOwner: `${owner}/${name}`,
              isPrivate: false,
              defaultBranchRef: { name: "main" },
              owner: { login: owner },
            },
          }),
          () => ({ repository: null }),
        ],
      },
    });
    const gh = github({ auth: { token: "unused" }, transport });
    const recipes = gh.owner("pantry-labs").repo("recipes");
    expect(await recipes.load()).toMatchObject({ id: "R_1", defaultBranch: "main" });
    await expect(gh.owner("pantry-labs").repo("missing").load()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("throws RESPONSE_SHAPE when the owner is missing from the response", async () => {
    const transport = new ScriptedTransport({
      graphql: { OwnerLoad: () => ({ repositoryOwner: null }) },
    });
    const gh = github({ auth: { token: "unused" }, transport });
    await expect(gh.owner("ghost").load()).rejects.toBeInstanceOf(GitHubError);
  });

  it("exposes unimplemented families as UNSUPPORTED, not undefined", async () => {
    const gh = github({ auth: { token: "unused" }, transport: new ScriptedTransport() });
    const repo = gh.owner("pantry-labs").repo("recipes");
    await expect(repo.issues.create({ title: "x" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});
