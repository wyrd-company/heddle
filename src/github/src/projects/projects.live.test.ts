import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveAuth } from "../testing/live-auth.js";
import { github } from "../github.js";
import { nodeId, type NodeId } from "../refs.js";
import { defineIssueFields, defineProject } from "../schema/define.js";
import { collect } from "../transport/paginate.js";

const token = process.env["GITHUB_TOKEN"];
const owner = process.env["GITHUB_TEST_OWNER"];
const repo = process.env["GITHUB_TEST_REPO"];
const run = `zz-${Date.now().toString(36)}`;

/** Retries an assertion while GitHub's listing index catches up. */
async function eventually(check: () => Promise<void>, tries = 10): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await check();
    } catch (error) {
      if (attempt >= tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}
const prio = `${run}-Prio`;

describe.skipIf(!token || !owner || !repo)("live: projects", () => {
  const gh = github({ auth: { token: token! } });
  // Repository writes (issue creation and closing) may need a different credential.
  const repoGh = github({ auth: liveAuth("repo") ?? { token: token! } });
  const issueFields = defineIssueFields({
    [prio]: { type: "singleSelect", options: ["High", "Low"] },
  });
  const board = defineProject({
    title: `${run} pipeline`,
    fields: {
      Status: { type: "singleSelect", options: ["Idea", { name: "Drafting", color: "BLUE" }] },
      Servings: { type: "number" },
      Notes: { type: "text" },
      Due: { type: "date" },
      Week: { type: "iteration", startDate: "2026-10-05", duration: 7 },
      Tags: { type: "multiSelect", options: ["vegan", "quick"] },
      [prio]: { type: "issueField" },
    },
  });
  const pantry = gh.owner(owner!, { issueFields });
  let orgFieldId: string | undefined;
  let projectId: NodeId | undefined;
  let issueNumber: number | undefined;

  beforeAll(async () => {
    const org = (await gh.raw.graphql(`{ organization(login: "${owner}") { id } }`)) as {
      organization: { id: string };
    };
    const created = (await gh.raw.graphql(
      `mutation($input: CreateIssueFieldInput!) { createIssueField(input: $input) { issueField { ... on IssueFieldSingleSelect { id } } } }`,
      {
        input: {
          ownerId: org.organization.id,
          name: prio,
          dataType: "SINGLE_SELECT",
          options: [
            { name: "High", color: "RED", priority: 1 },
            { name: "Low", color: "GRAY", priority: 2 },
          ],
        },
      },
    )) as { createIssueField: { issueField: { id: string } } };
    orgFieldId = created.createIssueField.issueField.id;
  });

  afterAll(async () => {
    if (projectId) {
      await gh.raw.graphql(
        `mutation { deleteProjectV2(input: { projectId: "${projectId}" }) { clientMutationId } }`,
      );
    }
    if (orgFieldId) {
      await gh.raw.graphql(
        `mutation { deleteIssueField(input: { fieldId: "${orgFieldId}" }) { clientMutationId } }`,
      );
    }
    if (issueNumber) {
      await repoGh.raw.rest(`PATCH /repos/${owner}/${repo}/issues/${issueNumber}`, {
        state: "closed",
      });
    }
  });

  it("ensure creates a conforming project, then is idempotent, then evolves", async () => {
    const project = await pantry.project(board).ensure();
    projectId = project.id;
    const kinds = project.lastEnsure.changes.map((c) => c.kind);
    expect(kinds.filter((k) => k === "created")).toHaveLength(6);
    expect(project.lastEnsure.changes).toContainEqual({
      kind: "option-added",
      field: "Status",
      option: "Idea",
    });

    const again = await pantry.project(board, { number: project.number }).ensure();
    expect(
      again.lastEnsure.changes.filter(
        (c) => c.kind !== "unchanged" && c.kind !== "option-unmanaged",
      ),
    ).toEqual([]);

    const evolved = defineProject({
      title: board.title,
      fields: {
        Status: { type: "singleSelect", options: ["Idea", "Drafting", "Archived"] },
        Servings: { type: "number" },
      },
    });
    const next = await pantry.project(evolved, { number: project.number }).ensure();
    expect(next.lastEnsure.changes).toContainEqual({
      kind: "option-added",
      field: "Status",
      option: "Archived",
    });
    expect(next.lastEnsure.changes).toContainEqual({ kind: "field-unmanaged", field: "Tags" });
    expect((await project.fields.get("Status")).options.map((o) => o.name)).toContain("Archived");
    await expect(pantry.project(board, { number: project.number }).open()).resolves.toBeDefined();
  });

  it("updates metadata and links a repository", async (ctx) => {
    const project = await pantry.project(board).open();
    await project.update({ shortDescription: "Every recipe from idea to publication" });
    expect((await project.load()).shortDescription).toBe("Every recipe from idea to publication");
    try {
      await project.linkRepository(`${owner}/${repo}`);
    } catch (error) {
      if ((error as { code?: string }).code === "FORBIDDEN") {
        ctx.skip("token cannot link repositories to projects");
        return;
      }
      throw error;
    }
    expect((await project.load()).repositories).toContain(`${owner}/${repo}`);
  });

  it("drives a draft item through every project field kind", async () => {
    const project = await pantry.project(board).open();
    const item = await project.add({ draft: { title: `${run} green curry` } });
    await item.set({
      Status: "Drafting",
      Servings: 4,
      Notes: "coconut milk",
      Due: "2026-10-20",
      Week: "2026-10-13",
      Tags: ["quick"],
    });
    expect(await item.get()).toEqual({
      Status: "Drafting",
      Servings: 4,
      Notes: "coconut milk",
      Due: "2026-10-20",
      Week: { title: "Iteration 2" },
      Tags: ["quick"],
      [prio]: null,
    });
    await expect(item.set({ [prio]: "High" })).rejects.toMatchObject({ code: "VALIDATION" });
    await item.set({ Notes: null });
    expect((await item.get()).Notes).toBeNull();

    await item.editDraft({ title: `${run} green curry v2` });
    expect((await item.load()).title).toBe(`${run} green curry v2`);
    const draftId = (await item.load()).contentId!;
    expect((await project.itemFor(draftId))?.id).toBe(item.id);

    // The items listing lags writes on GitHub's side; the item's own state does not.
    await eventually(async () =>
      expect((await collect(project.items())).map((i) => i.id)).toContain(item.id),
    );
    await item.archive();
    expect((await item.load()).archived).toBe(true);
    await item.unarchive();
    expect((await item.load()).archived).toBe(false);

    const status = await project.postStatus({
      status: "ON_TRACK",
      body: "cooking",
      startDate: "2026-10-05",
    });
    await status.edit({ status: "AT_RISK" });
    expect((await collect(project.statusUpdates()))[0]).toMatchObject({
      status: "AT_RISK",
      body: "cooking",
    });
    await status.delete();
    await item.remove();
  });

  it("sets an org-field-backed value through a real issue", async (ctx) => {
    let issue: { number: number; node_id: string };
    try {
      const created = await repoGh.raw.rest(`POST /repos/${owner}/${repo}/issues`, {
        title: `${run} issue`,
      });
      issue = created.data as { number: number; node_id: string };
    } catch (error) {
      if ((error as { code?: string }).code === "FORBIDDEN") {
        ctx.skip("token cannot create issues in the sandbox");
        return;
      }
      throw error;
    }
    issueNumber = issue.number;
    const project = await pantry.project(board).open();
    const item = await project.add(`${owner}/${repo}#${issue.number}`);
    try {
      await item.set({ [prio]: "High", Status: "Idea" });
    } catch (error) {
      if ((error as { code?: string }).code === "FORBIDDEN") {
        ctx.skip("issue-field values are written through the issue; needs a dual-scope credential");
        return;
      }
      throw error;
    }
    expect(await item.get()).toMatchObject({ [prio]: "High", Status: "Idea" });
    await item.set({ [prio]: null });
    expect((await item.get())[prio]).toBeNull();
    expect((await project.itemFor(nodeId(issue.node_id)))?.id).toBe(item.id);
  });
});
