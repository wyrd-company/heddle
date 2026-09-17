import { describe, expect, it, afterAll } from "vitest";
import { github } from "../github.js";

const token = process.env["GITHUB_TOKEN"];
const owner = process.env["GITHUB_TEST_OWNER"];

// Unique prefix for this test run
const runId = Math.random().toString(36).slice(2, 8);
const prefix = `zz-${runId}-`;

describe.skipIf(!token || !owner)("live: owner catalogs (issue types and fields)", () => {
  const gh = github({ auth: { token: token! } });
  const ownerHandle = gh.owner(owner!);

  afterAll(async () => {
    // Clean up created issue types
    for await (const it of ownerHandle.issueTypes.list()) {
      if (it.name.startsWith(prefix)) {
        try {
          await ownerHandle.issueTypes.delete(it.name);
        } catch {
          // Ignore errors during cleanup
        }
      }
    }
    // Clean up created issue fields
    for await (const field of ownerHandle.issueFields.list()) {
      if (field.name.startsWith(prefix)) {
        try {
          await ownerHandle.issueFields.delete(field.name);
        } catch {
          // Ignore errors during cleanup
        }
      }
    }
  });

  it("creates and ensures an issue type", async () => {
    const name = `${prefix}test-type`;
    const spec = { name, color: "BLUE" as const, enabled: true };

    const report1 = await ownerHandle.issueTypes.ensure(spec);
    expect(report1.changes.some((c) => c.kind === "created")).toBe(true);
    expect(report1.resources).toHaveLength(1);
    expect(report1.resources[0]!.name).toBe(name);

    const report2 = await ownerHandle.issueTypes.ensure(spec);
    expect(report2.changes.some((c) => c.kind === "unchanged")).toBe(true);

    const report3 = await ownerHandle.issueTypes.ensure({ ...spec, color: "RED" as const });
    expect(report3.changes.some((c) => c.kind === "updated")).toBe(true);
  });

  it("creates and ensures an issue field", async () => {
    const name = `${prefix}test-field`;
    const spec = {
      name,
      type: "text" as const,
      description: "A test field",
      visibility: "ALL" as const,
    };

    const report1 = await ownerHandle.issueFields.ensure(spec);
    expect(report1.changes.some((c) => c.kind === "created")).toBe(true);
    expect(report1.resources).toHaveLength(1);
    expect(report1.resources[0]!.name).toBe(name);

    const report2 = await ownerHandle.issueFields.ensure(spec);
    expect(report2.changes.some((c) => c.kind === "unchanged")).toBe(true);

    const report3 = await ownerHandle.issueFields.ensure({ ...spec, description: "Updated field" });
    expect(report3.changes.some((c) => c.kind === "updated")).toBe(true);
  });

  it("creates and ensures a single-select issue field with options", async () => {
    const name = `${prefix}select-field`;
    const spec = {
      name,
      type: "singleSelect" as const,
      options: ["Option A", { name: "Option B", color: "BLUE" as const }],
      visibility: "ALL" as const,
    };

    const report1 = await ownerHandle.issueFields.ensure(spec);
    expect(report1.changes.some((c) => c.kind === "created")).toBe(true);

    const field = report1.resources[0]!;
    expect(field.options).toHaveLength(2);

    const report2 = await ownerHandle.issueFields.ensure(spec);
    expect(report2.changes.some((c) => c.kind === "unchanged")).toBe(true);

    // GitHub cannot append options to an existing org issue field through the API;
    // the adapter refuses instead of replacing the option set and orphaning values.
    const spec3 = {
      ...spec,
      options: [...spec.options, { name: "Option C", color: "GREEN" as const }],
    };
    await expect(ownerHandle.issueFields.ensure(spec3)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});
