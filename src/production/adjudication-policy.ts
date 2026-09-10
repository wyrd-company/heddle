// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

const execute = promisify(execFile);
const objectId = /^[0-9a-f]{40,64}$/;

const policySchema = z
  .object({
    $schema: z.literal(
      "https://wyrd.company/heddle/adjudication-policy.schema.json",
    ),
    relationships: z.object({ implements: z.literal("heddle") }).strict(),
    "decision-boundary": z
      .object({
        decide: z.array(z.string().trim().min(1)).min(1),
        escalate: z.array(z.string().trim().min(1)).min(1),
        test: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

export type AdjudicationPolicy = z.infer<typeof policySchema>;

export type PinnedAdjudicationPolicy = {
  blobHash: string;
  path: string;
  policy: AdjudicationPolicy;
};

const requirePolicyPath = (path: string): void => {
  if (!/^adjudication\/[a-z][a-z-]*\.json$/.test(path)) {
    throw new TypeError("Adjudication policy path is invalid");
  }
};

export const readAdjudicationPolicyBlob = async (input: {
  blobHash: string;
  path: string;
  repositoryRoot: string;
}): Promise<PinnedAdjudicationPolicy> => {
  requirePolicyPath(input.path);
  if (!objectId.test(input.blobHash)) {
    throw new Error("Adjudication policy did not resolve to a Git blob");
  }
  const { stdout: serialized } = await execute(
    "git",
    ["cat-file", "blob", input.blobHash],
    { cwd: resolve(input.repositoryRoot), maxBuffer: 1024 * 1024 },
  );
  return {
    blobHash: input.blobHash,
    path: input.path,
    policy: policySchema.parse(JSON.parse(serialized) as unknown),
  };
};

export const readPinnedAdjudicationPolicy = async (input: {
  path: string;
  repositoryRoot: string;
  sourceRef: string;
}): Promise<PinnedAdjudicationPolicy> => {
  requirePolicyPath(input.path);
  const repositoryRoot = resolve(input.repositoryRoot);
  const { stdout: commitOutput } = await execute(
    "git",
    [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${input.sourceRef}^{commit}`,
    ],
    { cwd: repositoryRoot },
  );
  const commit = commitOutput.trim();
  if (!objectId.test(commit)) {
    throw new Error("Adjudication policy source did not resolve to a commit");
  }
  const { stdout: blobOutput } = await execute(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${commit}:${input.path}`],
    { cwd: repositoryRoot },
  );
  const blobHash = blobOutput.trim();
  if (!objectId.test(blobHash)) {
    throw new Error("Adjudication policy did not resolve to a Git blob");
  }
  return readAdjudicationPolicyBlob({
    blobHash,
    path: input.path,
    repositoryRoot,
  });
};

export const renderAdjudicationBoundary = (
  policy: AdjudicationPolicy,
): string =>
  [
    "Decide when:",
    ...policy["decision-boundary"].decide.map((rule) => `- ${rule}`),
    "",
    "Escalate when:",
    ...policy["decision-boundary"].escalate.map((rule) => `- ${rule}`),
    "",
    `Decision test: ${policy["decision-boundary"].test}`,
  ].join("\n");
