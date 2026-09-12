// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";

import { execute } from "./composition.test-support.js";
import {
  readAdjudicationPolicyBlob,
  readPinnedAdjudicationPolicy,
} from "./adjudication-policy.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const policy = (decision: string) => ({
  $schema: "https://wyrd.company/heddle/adjudication-policy.schema.json",
  relationships: { implements: "heddle" },
  "decision-boundary": {
    decide: [decision],
    escalate: ["Escalate a material product decision."],
    test: "Who outside the current effort would break?",
  },
});

it("publishes a decision boundary without adjudication execution limits", async () => {
  const schema = JSON.parse(
    await readFile("schemas/adjudication-policy.json", "utf8"),
  );
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const boundary = policy("Decide the reversible detail.");
  expect(validate(boundary)).toBe(true);
  expect(validate({ ...boundary, limits: { maximumTurns: 1 } })).toBe(false);
  expect(
    validate({ ...boundary, limits: { timeoutMilliseconds: 60_000 } }),
  ).toBe(false);
});

it("reads the retained policy blob after the configured source advances", async () => {
  const root = await mkdtemp(join(tmpdir(), "heddle-adjudication-policy-"));
  roots.push(root);
  await mkdir(join(root, "adjudication"));
  await execute("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: root,
  });
  await writeFile(
    join(root, "adjudication", "policy.json"),
    JSON.stringify(policy("Decide the first reversible detail.")),
  );
  await execute("git", ["add", "adjudication/policy.json"], { cwd: root });
  await execute(
    "git",
    [
      "-c",
      "user.name=Fixture User",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Add first policy",
    ],
    { cwd: root },
  );
  const pinned = await readPinnedAdjudicationPolicy({
    path: "adjudication/policy.json",
    repositoryRoot: root,
    sourceRef: "main",
  });

  await writeFile(
    join(root, "adjudication", "policy.json"),
    JSON.stringify(policy("Decide the second reversible detail.")),
  );
  await execute("git", ["add", "adjudication/policy.json"], { cwd: root });
  await execute(
    "git",
    [
      "-c",
      "user.name=Fixture User",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Change policy",
    ],
    { cwd: root },
  );

  const retained = await readAdjudicationPolicyBlob({
    blobHash: pinned.blobHash,
    path: pinned.path,
    repositoryRoot: root,
  });
  expect(retained.policy["decision-boundary"].decide).toEqual([
    "Decide the first reversible detail.",
  ]);
});

it.each([{ maximumTurns: 1 }, { timeoutMilliseconds: 60_000 }])(
  "rejects removed adjudication execution limits %j",
  async (limits) => {
    const root = await mkdtemp(join(tmpdir(), "heddle-adjudication-policy-"));
    roots.push(root);
    await mkdir(join(root, "adjudication"));
    await execute("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: root,
    });
    await writeFile(
      join(root, "adjudication", "policy.json"),
      JSON.stringify({
        ...policy("Decide the reversible detail."),
        limits,
      }),
    );
    await execute("git", ["add", "adjudication/policy.json"], { cwd: root });
    await execute(
      "git",
      [
        "-c",
        "user.name=Fixture User",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Add policy with removed timeout",
      ],
      { cwd: root },
    );

    await expect(
      readPinnedAdjudicationPolicy({
        path: "adjudication/policy.json",
        repositoryRoot: root,
        sourceRef: "main",
      }),
    ).rejects.toThrow(/limits|unrecognized/i);
  },
);
