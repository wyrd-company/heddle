import { describe, expect, it, afterAll } from "vitest";
import { github } from "../github.js";
import { liveAuth } from "../testing/live-auth.js";

const auth = liveAuth("repo");
const owner = process.env["GITHUB_TEST_OWNER"];
const repo = process.env["GITHUB_TEST_REPO"];

// Unique prefix for this test run
const runId = Math.random().toString(36).slice(2, 8);
const prefix = `zz-${runId}-`;

describe.skipIf(!auth || !owner || !repo)("live: repo catalogs (labels and milestones)", () => {
  const gh = github({ auth: auth! });
  const repoHandle = gh.owner(owner!).repo(repo!);

  afterAll(async () => {
    // Clean up created labels
    for await (const label of repoHandle.labels.list()) {
      if (label.name.startsWith(prefix)) {
        try {
          await repoHandle.labels.delete(label.name);
        } catch {
          // Ignore errors during cleanup
        }
      }
    }

    // Clean up created milestones
    for await (const milestone of repoHandle.milestones.list()) {
      if (milestone.name.startsWith(prefix)) {
        try {
          await repoHandle.milestones.delete(milestone.name);
        } catch {
          // Ignore errors during cleanup
        }
      }
    }
  });

  it("creates and ensures a label", async () => {
    const name = `${prefix}test-label`;
    const spec = { name, color: "FF0000", description: "A test label" };

    const report1 = await repoHandle.labels.ensure(spec);
    expect(report1.changes.some((c) => c.kind === "created")).toBe(true);
    expect(report1.resources).toHaveLength(1);
    expect(report1.resources[0]!.name).toBe(name);

    const report2 = await repoHandle.labels.ensure(spec);
    expect(report2.changes.some((c) => c.kind === "unchanged")).toBe(true);

    const report3 = await repoHandle.labels.ensure({ ...spec, color: "00FF00" });
    expect(report3.changes.some((c) => c.kind === "updated")).toBe(true);
  });

  it("deletes a label idempotently", async () => {
    const name = `${prefix}delete-label`;
    const spec = { name, color: "FF0000" };

    await repoHandle.labels.ensure(spec);

    // Delete should work
    await repoHandle.labels.delete(name);

    // Deleting again should not error
    await repoHandle.labels.delete(name);
  });

  it("creates and ensures a milestone", async () => {
    const name = `${prefix}v1.0.0`;
    const spec = { name, description: "First release", dueOn: "2024-12-31" as const };

    const report1 = await repoHandle.milestones.ensure(spec);
    expect(report1.changes.some((c) => c.kind === "created")).toBe(true);
    expect(report1.resources).toHaveLength(1);
    expect(report1.resources[0]!.name).toBe(name);

    const report2 = await repoHandle.milestones.ensure(spec);
    expect(report2.changes.some((c) => c.kind === "unchanged")).toBe(true);

    const report3 = await repoHandle.milestones.ensure({ ...spec, description: "Updated release" });
    expect(report3.changes.some((c) => c.kind === "updated")).toBe(true);
  });

  it("deletes a milestone idempotently", async () => {
    const name = `${prefix}delete-milestone`;
    const spec = { name, state: "open" as const };

    await repoHandle.milestones.ensure(spec);

    // Delete should work
    await repoHandle.milestones.delete(name);

    // Deleting again should not error
    await repoHandle.milestones.delete(name);
  });
});
