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
  HandoffTemplateError,
  readPinnedOutputContract,
} from "./handoff-template-store.js";

const execute = promisify(execFile);
const roots: string[] = [];

const repository = async (
  contracts: Record<string, unknown>,
): Promise<{ commitSha: string; root: string }> => {
  const root = await mkdtemp(join(tmpdir(), "heddle-output-contracts-"));
  roots.push(root);
  await mkdir(join(root, "output-contracts"));
  for (const [name, schema] of Object.entries(contracts)) {
    await writeFile(
      join(root, "output-contracts", `${name}.json`),
      JSON.stringify(schema),
    );
  }
  await execute("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: root,
  });
  await execute("git", ["add", "output-contracts"], { cwd: root });
  await execute(
    "git",
    [
      "-c",
      "user.name=Sample User",
      "-c",
      "user.email=sample@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "add contracts",
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

describe("pinned output contracts", () => {
  it("reads a schema artifact at the pinned commit", async () => {
    const schema = { required: ["findings"], type: "object" };
    const { commitSha, root } = await repository({ "sample-findings": schema });
    await writeFile(
      join(root, "output-contracts", "sample-findings.json"),
      JSON.stringify({ type: "string" }),
    );
    await expect(
      readPinnedOutputContract(root, commitSha, "sample-findings"),
    ).resolves.toEqual(schema);
  });

  it("rejects an artifact that is absent at the pinned commit", async () => {
    const { commitSha, root } = await repository({});
    await expect(
      readPinnedOutputContract(root, commitSha, "sample-findings"),
    ).rejects.toThrow(
      new HandoffTemplateError(
        `Pinned output contract is unavailable at commit ${commitSha}: output-contracts/sample-findings.json`,
      ),
    );
  });

  it("rejects an artifact that is not a JSON Schema", async () => {
    const { commitSha, root } = await repository({
      broken: { type: "not-a-type" },
    });
    await expect(
      readPinnedOutputContract(root, commitSha, "broken"),
    ).rejects.toThrow(/broken\.json at commit .* is not a valid JSON Schema/);
  });

  it("rejects a contract name that is not an artifact id", async () => {
    const { commitSha, root } = await repository({});
    await expect(
      readPinnedOutputContract(root, commitSha, "../secrets"),
    ).rejects.toThrow(/kebab-case artifact id/);
  });
});
