import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { github, type GitHub } from "../github.js";
import { liveAuth } from "../testing/live-auth.js";
import type { Issue } from "./issue.js";

const auth = liveAuth("repo");
const owner = process.env["GITHUB_TEST_OWNER"];
const repoName = process.env["GITHUB_TEST_REPO"];
const enabled = Boolean(auth && owner && repoName);

describe.skipIf(!enabled)("live: issues", () => {
  const prefix = `zz-${Date.now().toString(36)}-`;
  let gh: GitHub;
  let first: Issue<Record<string, never>>;
  let second: Issue<Record<string, never>>;
  const labelName = `${prefix}label`;
  const repo = () => gh.owner(owner!).repo(repoName!);

  beforeAll(async () => {
    gh = github({ auth: auth! });
    await repo().labels.ensure({ name: labelName, color: "0e8a16" });
    first = await repo().issues.create({ title: `${prefix}first`, body: "First test issue" });
    second = await repo().issues.create({ title: `${prefix}second`, body: "Second test issue" });
  });

  afterAll(async () => {
    for (const issue of [first, second]) {
      if (!issue) continue;
      try {
        await issue.close({ reason: "not-planned" });
      } catch {
        // already closed
      }
    }
    await repo().labels.delete(labelName);
  });

  it("sets title, labels and assignees", async () => {
    await first.set({ title: `${prefix}renamed`, labels: [labelName] });
    let data = await first.load();
    expect(data.title).toBe(`${prefix}renamed`);
    expect(data.labels.map((l) => l.name)).toEqual([labelName]);

    // App installation tokens act as a bot, and bots cannot be assigned; a human
    // login comes from GITHUB_TEST_ASSIGNEE when the suite runs under an App.
    const viewer = (await gh.raw.graphql("query { viewer { login } }")) as {
      viewer: { login: string };
    };
    const assignee = viewer.viewer.login.endsWith("[bot]")
      ? process.env["GITHUB_TEST_ASSIGNEE"]
      : viewer.viewer.login;
    await first.set({
      ...(assignee ? { assignees: [assignee] } : {}),
      labels: { remove: [labelName] },
    });
    data = await first.load();
    if (assignee) expect(data.assignees).toEqual([assignee]);
    expect(data.labels).toEqual([]);
  });

  it("links parent and blockedBy, then unlinks", async () => {
    await second.link({ parent: first, blockedBy: [first] });
    let data = await second.load();
    expect(data.parent).toBe(first.ref);
    expect(data.blockedBy).toEqual([first.ref]);

    await first.moveSubIssue(second, { after: null });
    await second.unlink({ parent: null, blockedBy: [first] });
    data = await second.load();
    expect(data.parent).toBeNull();
    expect(data.blockedBy).toEqual([]);
  });

  it("comments, edits, and reacts", async () => {
    const comment = await first.comment(`${prefix}comment`);
    await comment.edit(`${prefix}edited`);
    await comment.react("ROCKET");
    await first.react("THUMBS_UP");
    await first.unreact("THUMBS_UP");
    const bodies: string[] = [];
    for await (const c of first.comments()) bodies.push(c.body);
    expect(bodies).toContain(`${prefix}edited`);
  });

  it("closes as duplicate, unmarks, reopens, and closes completed", async () => {
    await second.close({ reason: "duplicate", of: first });
    let data = await second.load();
    expect(data.state).toBe("closed");
    expect(data.stateReason).toBe("duplicate");
    expect(data.duplicateOf).toBe(first.ref);

    await second.unmarkDuplicate();
    await second.reopen();
    data = await second.load();
    expect(data.state).toBe("open");

    await second.close({ reason: "completed" });
    data = await second.load();
    expect(data.stateReason).toBe("completed");
  });

  it("lists open issues with the run prefix", async () => {
    const titles: string[] = [];
    for await (const data of repo().issues.list({ state: "open" })) titles.push(data.title);
    expect(titles.some((t) => t.startsWith(prefix))).toBe(true);
  });
});
