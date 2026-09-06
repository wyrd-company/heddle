// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import { basename, dirname, extname } from "node:path";
import { promisify } from "node:util";

import { parse } from "yaml";

const execute = promisify(execFile);
const gitObjectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const artifactId = /^[a-z]+(?:-[a-z]+)*$/;
const schemaId = "https://wyrd.company/heddle/handoff-template.schema.json";

export type HandoffTemplateKind = "remediation" | "standard";

export type PinnedHandoffTemplateReference = {
  commitSha: string;
  path: string;
};

export type PinnedHandoffTemplate = PinnedHandoffTemplateReference & {
  body: string;
  includes: Readonly<Record<string, string>>;
  kind: HandoffTemplateKind;
};

export class HandoffTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffTemplateError";
  }
}

const assertReference = (reference: PinnedHandoffTemplateReference): void => {
  if (!gitObjectId.test(reference.commitSha)) {
    throw new HandoffTemplateError("Handoff template commit SHA is invalid");
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
): Omit<PinnedHandoffTemplate, "includes"> => {
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

const includeDirectory = "handoff-templates/includes/";

const readPinnedPath = async (
  repositoryRoot: string,
  commitSha: string,
  path: string,
): Promise<string> =>
  (
    await execute("git", ["cat-file", "-p", `${commitSha}:${path}`], {
      cwd: repositoryRoot,
      maxBuffer: 10 * 1024 * 1024,
    })
  ).stdout;

const readPinnedIncludes = async (
  repositoryRoot: string,
  commitSha: string,
): Promise<Readonly<Record<string, string>>> => {
  const { stdout } = await execute(
    "git",
    [
      "ls-tree",
      "-rz",
      "-r",
      "--full-tree",
      "--name-only",
      commitSha,
      "--",
      includeDirectory,
    ],
    { cwd: repositoryRoot, maxBuffer: 10 * 1024 * 1024 },
  );
  const paths = stdout.split("\0").filter((path) => path !== "");
  return Object.freeze(
    Object.fromEntries(
      await Promise.all(
        paths.map(async (path) => [
          path,
          await readPinnedPath(repositoryRoot, commitSha, path),
        ]),
      ),
    ),
  );
};

export class GitHandoffTemplateStore {
  constructor(private readonly repositoryRoot: string) {}

  async read(
    reference: PinnedHandoffTemplateReference,
  ): Promise<PinnedHandoffTemplate> {
    assertReference(reference);
    try {
      await execute(
        "git",
        ["cat-file", "-e", `${reference.commitSha}^{commit}`],
        {
          cwd: this.repositoryRoot,
        },
      );
    } catch {
      throw new HandoffTemplateError(
        `Pinned handoff template commit is unavailable: ${reference.commitSha}`,
      );
    }
    let serialized: string;
    let includes: Readonly<Record<string, string>>;
    try {
      [serialized, includes] = await Promise.all([
        readPinnedPath(
          this.repositoryRoot,
          reference.commitSha,
          reference.path,
        ),
        readPinnedIncludes(this.repositoryRoot, reference.commitSha),
      ]);
    } catch {
      throw new HandoffTemplateError(
        `Pinned handoff template path is unavailable at commit ${reference.commitSha}: ${reference.path}`,
      );
    }
    const template = { ...parseTemplate(serialized, reference), includes };
    try {
      await execute(
        "git",
        [
          "update-ref",
          `refs/heddle/handoff-templates/${reference.commitSha}`,
          reference.commitSha,
        ],
        { cwd: this.repositoryRoot },
      );
    } catch {
      throw new HandoffTemplateError(
        `Pinned handoff template ref could not be retained: ${reference.commitSha}`,
      );
    }
    return template;
  }
}
