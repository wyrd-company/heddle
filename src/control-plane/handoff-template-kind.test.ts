// ---
// relationships:
//   verifies: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  GitHandoffTemplateStore,
  HandoffTemplateError,
} from "./handoff-template-store.js";

const execute = promisify(execFile);
const roots: string[] = [];

const template = (kind: string): string =>
  [
    "---",
    "$schema: https://wyrd.company/heddle/handoff-template.schema.json",
    "relationships:",
    "  implements: heddle",
    "format: heddle.handoff-template",
    "version: 1",
    `kind: ${kind}`,
    "---",
    "# {{ task.title }}",
    "",
  ].join("\n");

const repository = async (
  kind: string,
): Promise<{ commitSha: string; root: string }> => {
  const root = await mkdtemp(join(tmpdir(), "heddle-template-kind-"));
  roots.push(root);
  await mkdir(join(root, "handoff-templates"));
  await writeFile(join(root, "handoff-templates", "repair.md"), template(kind));
  await execute("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: root,
  });
  await execute("git", ["add", "handoff-templates"], { cwd: root });
  await execute(
    "git",
    [
      "-c",
      "user.name=Sample User",
      "-c",
      "user.email=sample@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "add template",
    ],
    { cwd: root },
  );
  const commitSha = (
    await execute("git", ["rev-parse", "HEAD"], { cwd: root })
  ).stdout.trim();
  return { commitSha, root };
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("handoff template kinds", () => {
  it("accepts a kind Heddle has never seen", async () => {
    const { commitSha, root } = await repository("repair-instructions");
    await expect(
      new GitHandoffTemplateStore(root).read({
        commitSha,
        path: "handoff-templates/repair.md",
      }),
    ).resolves.toMatchObject({ kind: "repair-instructions" });
  });

  it("rejects a kind that is not a kebab-case word", async () => {
    const { commitSha, root } = await repository("Repair Instructions");
    await expect(
      new GitHandoffTemplateStore(root).read({
        commitSha,
        path: "handoff-templates/repair.md",
      }),
    ).rejects.toThrow(HandoffTemplateError);
  });
});
