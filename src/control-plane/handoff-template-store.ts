// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import { basename, dirname, extname } from "node:path";
import { promisify } from "node:util";

import { parse } from "yaml";

const execute = promisify(execFile);
const gitObjectId = /^[0-9a-f]{40,64}$/;
const artifactId = /^[a-z]+(?:-[a-z]+)*$/;
const schemaId = "https://wyrd.company/heddle/handoff-template.schema.json";

export type HandoffTemplateKind = "remediation" | "standard";

export type PinnedHandoffTemplateReference = {
  blobHash: string;
  path: string;
};

export type PinnedHandoffTemplate = PinnedHandoffTemplateReference & {
  body: string;
  kind: HandoffTemplateKind;
};

export class HandoffTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffTemplateError";
  }
}

const assertReference = (reference: PinnedHandoffTemplateReference): void => {
  if (!gitObjectId.test(reference.blobHash)) {
    throw new HandoffTemplateError("Handoff template blob hash is invalid");
  }
  if (
    dirname(reference.path) !== "handoff-templates" ||
    extname(reference.path) !== ".md" ||
    !artifactId.test(basename(reference.path, ".md"))
  ) {
    throw new HandoffTemplateError(
      "Handoff template path must name a direct kebab-case Markdown artifact",
    );
  }
};

const parseTemplate = (
  serialized: string,
  reference: PinnedHandoffTemplateReference,
): PinnedHandoffTemplate => {
  if (!serialized.startsWith("---\n")) {
    throw new HandoffTemplateError("Handoff template has no YAML front matter");
  }
  const boundary = serialized.indexOf("\n---\n", 4);
  if (boundary === -1) {
    throw new HandoffTemplateError(
      "Handoff template front matter is not closed",
    );
  }
  let metadata: unknown;
  try {
    metadata = parse(serialized.slice(4, boundary));
  } catch (error) {
    throw new HandoffTemplateError(
      `Handoff template front matter is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    Object.keys(metadata).sort().join(",") !==
      "$schema,format,kind,relationships,version" ||
    (metadata as Record<string, unknown>)["$schema"] !== schemaId ||
    (metadata as Record<string, unknown>)["format"] !==
      "heddle.handoff-template" ||
    (metadata as Record<string, unknown>)["version"] !== 1 ||
    ((metadata as Record<string, unknown>)["kind"] !== "standard" &&
      (metadata as Record<string, unknown>)["kind"] !== "remediation") ||
    JSON.stringify((metadata as Record<string, unknown>)["relationships"]) !==
      JSON.stringify({ implements: "heddle" })
  ) {
    throw new HandoffTemplateError(
      "Handoff template front matter does not match its artifact contract",
    );
  }
  const body = serialized.slice(boundary + "\n---\n".length);
  if (body.trim() === "") {
    throw new HandoffTemplateError("Handoff template body must not be empty");
  }
  return {
    ...reference,
    body,
    kind: (metadata as { kind: HandoffTemplateKind }).kind,
  };
};

export class GitHandoffTemplateStore {
  constructor(private readonly repositoryRoot: string) {}

  async read(
    reference: PinnedHandoffTemplateReference,
  ): Promise<PinnedHandoffTemplate> {
    assertReference(reference);
    let stdout: string;
    try {
      ({ stdout } = await execute(
        "git",
        ["cat-file", "blob", reference.blobHash],
        { cwd: this.repositoryRoot, maxBuffer: 10 * 1024 * 1024 },
      ));
    } catch {
      throw new HandoffTemplateError(
        `Pinned handoff template blob is unavailable: ${reference.blobHash}`,
      );
    }
    return parseTemplate(stdout, reference);
  }
}
