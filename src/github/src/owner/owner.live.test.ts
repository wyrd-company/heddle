import { describe, expect, it } from "vitest";
import { github } from "../github.js";

const token = process.env["GITHUB_TOKEN"];
const owner = process.env["GITHUB_TEST_OWNER"];
const repo = process.env["GITHUB_TEST_REPO"];

describe.skipIf(!token || !owner)("live: owner and repository", () => {
  const gh = github({ auth: { token: token! } });

  it("loads the sandbox organization", async () => {
    const data = await gh.owner(owner!).load();
    expect(data.kind).toBe("organization");
    expect(data.login).toBe(owner);
    expect(data.id).toMatch(/^O_/);
  });

  it.skipIf(!repo)("loads the sandbox repository", async () => {
    const data = await gh.owner(owner!).repo(repo!).load();
    expect(data.nameWithOwner).toBe(`${owner}/${repo}`);
    expect(data.id).toMatch(/^R_/);
  });

  it("maps a missing repository to NOT_FOUND", async () => {
    await expect(gh.owner(owner!).repo("zz-does-not-exist").load()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
