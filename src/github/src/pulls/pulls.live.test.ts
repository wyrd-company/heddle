import { describe, expect, it, afterAll } from "vitest";
import { github } from "../github.js";
import { liveAuth } from "../testing/live-auth.js";

const auth = liveAuth("repo");
const owner = process.env["GITHUB_TEST_OWNER"];
const repo = process.env["GITHUB_TEST_REPO"];

describe.skipIf(!auth || !owner || !repo)("live: pull requests", () => {
  const prefix = `zz-${Date.now()}-`;
  const gh = github({ auth: auth! });
  let branchName = "";

  afterAll(async () => {
    // Sweep by prefix so a failure mid-test never leaves resources behind.
    const coords = { owner: owner!, repo: repo! };
    const open = await gh.raw.rest(`GET /repos/{owner}/{repo}/issues`, {
      ...coords,
      state: "open",
      per_page: 100,
    });
    for (const item of open.data as { number: number; title: string }[]) {
      if (!item.title.startsWith(prefix)) continue;
      await gh.raw.rest(`PATCH /repos/{owner}/{repo}/issues/{issue_number}`, {
        ...coords,
        issue_number: item.number,
        state: "closed",
      });
    }
    const labels = await gh.raw.rest(`GET /repos/{owner}/{repo}/labels`, {
      ...coords,
      per_page: 100,
    });
    for (const label of labels.data as { name: string }[]) {
      if (!label.name.startsWith(prefix)) continue;
      await gh.raw.rest(`DELETE /repos/{owner}/{repo}/labels/{name}`, {
        ...coords,
        name: label.name,
      });
    }
    if (branchName) {
      await gh.raw
        .rest(`DELETE /repos/{owner}/{repo}/git/refs/{ref}`, {
          ...coords,
          ref: `heads/${branchName}`,
        })
        .catch(() => undefined);
    }
  });

  it("creates and manages a pull request", async () => {
    const repoData = await gh.owner(owner!).repo(repo!).load();
    const defaultBranch = repoData.defaultBranch || "main";
    branchName = `${prefix}test-pr`;

    // Get default branch head
    const refResp = await gh.raw.rest(`GET /repos/{owner}/{repo}/git/refs/{ref}`, {
      owner: owner!,
      repo: repo!,
      ref: `heads/${defaultBranch}`,
    });
    const sha = (refResp.data as { object: { sha: string } }).object.sha;

    // Create branch
    await gh.raw.rest(`POST /repos/{owner}/{repo}/git/refs`, {
      owner: owner!,
      repo: repo!,
      ref: `refs/heads/${branchName}`,
      sha,
    });

    // Add commit
    await gh.raw.rest(`PUT /repos/{owner}/{repo}/contents/{path}`, {
      owner: owner!,
      repo: repo!,
      path: `${prefix}test.txt`,
      message: `Add test file`,
      content: Buffer.from("test content").toString("base64"),
      branch: branchName,
    });

    // Create draft PR
    const pr = await gh
      .owner(owner!)
      .repo(repo!)
      .pulls.create({
        title: `${prefix}Test PR`,
        head: branchName,
        base: defaultBranch,
        draft: true,
      });

    let data = await pr.load();
    expect(data.isDraft).toBe(true);
    expect(data.title).toBe(`${prefix}Test PR`);

    // Set title
    await pr.set({ title: `${prefix}Updated PR` });
    data = await pr.load();
    expect(data.title).toBe(`${prefix}Updated PR`);

    // Create label
    await gh.raw.rest(`POST /repos/{owner}/{repo}/labels`, {
      owner: owner!,
      repo: repo!,
      name: `${prefix}test-label`,
      color: "FF0000",
    });

    // Add label
    await pr.set({ labels: [`${prefix}test-label`] });
    data = await pr.load();
    expect(data.labels.some((l) => l.name === `${prefix}test-label`)).toBe(true);

    // Mark ready for review
    await pr.set({ draft: false });
    data = await pr.load();
    expect(data.isDraft).toBe(false);

    // Create issue to link
    const issue = await gh
      .owner(owner!)
      .repo(repo!)
      .issues.create({ title: `${prefix}Test Issue` });

    // Link issue
    await pr.link({ closes: [issue] });

    // Add thread
    const thread = await pr.thread({
      path: `${prefix}test.txt`,
      line: 1,
      body: "Comment on this line",
    });
    expect(thread.id).toBeDefined();

    // Reply to thread
    const comment = await thread.reply("Looks good!");
    expect(comment.id).toBeDefined();

    // Resolve thread
    await thread.resolve();

    // Unresolve thread
    await thread.unresolve();

    // Submit review
    const review = await pr.review({ event: "COMMENT", body: "Great work!" });
    expect(review.id).toBeDefined();

    // Unlink issue
    await pr.unlink({ closes: [issue] });

    // Close PR
    await pr.close();
    data = await pr.load();
    expect(data.state).toBe("closed");
  });
});
