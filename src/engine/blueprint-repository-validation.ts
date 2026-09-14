// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { Ajv2020 } from "ajv/dist/2020.js";

import {
  namesForThemeList,
  validateAgentNameThemeRepository,
  type AgentNameTheme,
} from "../agent-names/index.js";
import {
  agentNameThemeKindForBlueprint,
  validateBlueprint,
} from "./blueprint.js";
import { isBlueprintArtifactId } from "./blueprint-artifact.js";
import { BlueprintValidationError } from "./errors.js";
import type {
  LifecycleBlueprint,
  LifecycleEffect,
  LifecycleNode,
} from "./types.js";

const schemaPath = resolve(
  import.meta.dirname,
  "../../schemas/lifecycle-blueprint.json",
);
const adjudicationSchemaPath = resolve(
  import.meta.dirname,
  "../../schemas/adjudication-policy.json",
);
const execute = promisify(execFile);

const json = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const validateBlueprintToolRegistry = async (
  repositoryRoot: string,
  registeredTools: ReadonlySet<string>,
): Promise<void> => {
  const directory = join(resolve(repositoryRoot), "blueprints");
  const filenames = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name) === ".json")
    .map(({ name }) => name)
    .sort();
  for (const filename of filenames) {
    const artifactId = basename(filename, ".json");
    const artifact = await json(join(directory, filename));
    if (!record(artifact) || !Array.isArray(artifact["nodes"])) continue;
    for (const candidate of artifact["nodes"]) {
      if (!record(candidate) || candidate["uses"] !== "wait") continue;
      const nodeId = candidate["id"];
      const tools = candidate["tools"];
      if (typeof nodeId !== "string" || !Array.isArray(tools)) continue;
      for (const tool of tools) {
        if (typeof tool === "string" && !registeredTools.has(tool)) {
          throw new BlueprintValidationError(
            `Blueprint '${artifactId}' node '${nodeId}' declares MCP tool '${tool}' that is not registered`,
          );
        }
      }
    }
  }
};

const effectCatalog = (
  blueprint: LifecycleBlueprint,
): Record<string, LifecycleEffect> =>
  Object.fromEntries(
    blueprint.nodes
      .filter(({ uses }) => uses !== "wait")
      .map(({ uses }) => [uses, async () => ({})]),
  );

const assertTemplateRelationships = (
  artifactId: string,
  artifact: Record<string, unknown>,
  blueprint: LifecycleBlueprint,
): void => {
  const relationships = artifact["relationships"];
  if (!record(relationships) || !Array.isArray(relationships["uses"])) return;
  const bound = blueprint.nodes.flatMap((node) => {
    const values: string[] = [];
    if (node["todo-template"] !== undefined) {
      values.push(node["todo-template"]);
    }
    if (node["handoff-template"] !== undefined) {
      values.push(
        basename(
          node["handoff-template"].path,
          extname(node["handoff-template"].path),
        ),
      );
    }
    if (node.skills !== undefined) values.push(...node.skills);
    return values;
  });
  for (const edge of blueprint.edges) {
    if (edge["output-contract"] !== undefined) {
      bound.push(edge["output-contract"]);
    }
  }
  const declared = relationships["uses"].filter(
    (value): value is string => typeof value === "string",
  );
  if (
    JSON.stringify([...new Set(bound)].sort()) !==
    JSON.stringify([...declared].sort())
  ) {
    throw new BlueprintValidationError(
      `Blueprint '${artifactId}' relationships must name its bound artifacts`,
    );
  }
};

const assertOutputContractArtifacts = async (
  artifactId: string,
  blueprint: LifecycleBlueprint,
  repositoryRoot: string,
): Promise<void> => {
  const validator = new Ajv2020({ allErrors: true, strict: false });
  const nodes = new Map(blueprint.nodes.map((node) => [node.id, node]));
  // A stage reads its output contracts at its pinned template commit, so the
  // artifact that is validated is the one the runtime will read, not the
  // working tree's.
  const pinned = new Map<string, string>();
  for (const edge of blueprint.edges) {
    const name = edge["output-contract"];
    if (name === undefined) continue;
    const commitSha = nodes.get(edge.source)?.["handoff-template"]?.commitSha;
    if (commitSha === undefined) {
      throw new BlueprintValidationError(
        `Blueprint '${artifactId}' edge from '${edge.source}' binds output contract '${name}' but the node pins no handoff template commit`,
      );
    }
    pinned.set(`${commitSha}:${name}`, commitSha);
  }
  for (const [key, commitSha] of pinned) {
    const name = key.slice(commitSha.length + 1);
    const path = `output-contracts/${name}.json`;
    let serialized: string;
    try {
      serialized = (
        await execute("git", ["cat-file", "-p", `${commitSha}:${path}`], {
          cwd: repositoryRoot,
        })
      ).stdout;
    } catch {
      throw new BlueprintValidationError(
        `Blueprint '${artifactId}' names output contract '${name}' that is unavailable at commit ${commitSha}: ${path}`,
      );
    }
    let schema: unknown;
    try {
      schema = JSON.parse(serialized) as unknown;
    } catch (error) {
      throw new BlueprintValidationError(
        `Blueprint '${artifactId}' output contract '${name}' at commit ${commitSha} is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // Advance output is always an object; a boolean, array, or untyped schema
    // would be refused only when a session binds, far from the author.
    if (
      typeof schema !== "object" ||
      schema === null ||
      Array.isArray(schema) ||
      (schema as Record<string, unknown>)["type"] !== "object"
    ) {
      throw new BlueprintValidationError(
        `Blueprint '${artifactId}' output contract '${name}' must be an object schema with "type": "object"`,
      );
    }
    try {
      validator.compile(schema as object);
    } catch (error) {
      throw new BlueprintValidationError(
        `Blueprint '${artifactId}' output contract '${name}' is not a valid JSON Schema: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
};

const assertTemplateArtifacts = async (
  artifactId: string,
  nodes: LifecycleNode[],
  repositoryRoot: string,
): Promise<void> => {
  for (const node of nodes) {
    const pinned = node["handoff-template"];
    if (pinned !== undefined) {
      if (!/^(?:[\da-f]{40}|[\da-f]{64})$/.test(pinned.commitSha)) {
        throw new BlueprintValidationError(
          `Blueprint '${artifactId}' node '${node.id}' pins an invalid handoff template commit SHA`,
        );
      }
      try {
        await execute(
          "git",
          ["cat-file", "-e", `${pinned.commitSha}^{commit}`],
          {
            cwd: repositoryRoot,
          },
        );
      } catch {
        throw new BlueprintValidationError(
          `Blueprint '${artifactId}' node '${node.id}' pins unavailable handoff template commit ${pinned.commitSha}`,
        );
      }
      try {
        await execute(
          "git",
          ["cat-file", "-e", `${pinned.commitSha}:${pinned.path}`],
          { cwd: repositoryRoot },
        );
      } catch {
        throw new BlueprintValidationError(
          `Blueprint '${artifactId}' node '${node.id}' pins handoff template '${pinned.path}' that is unavailable at commit ${pinned.commitSha}`,
        );
      }
    }
    const todoTemplate = node["todo-template"];
    if (todoTemplate !== undefined) {
      const path = join(
        repositoryRoot,
        "todo-templates",
        `${todoTemplate}.json`,
      );
      const artifact = await stat(path).catch(() => undefined);
      if (artifact === undefined || !artifact.isFile()) {
        throw new BlueprintValidationError(
          `Blueprint '${artifactId}' node '${node.id}' names todo template '${todoTemplate}' that has no artifact in todo-templates/`,
        );
      }
    }
  }
};

const assertAgentNameThemeAvailability = (
  artifactId: string,
  blueprint: LifecycleBlueprint,
  themes: readonly AgentNameTheme[],
): void => {
  const kind = agentNameThemeKindForBlueprint(blueprint);
  if (kind === undefined) return;
  const lists = [
    ...new Set(
      blueprint.nodes.flatMap((node) =>
        node["assign-agent-name"] === undefined
          ? []
          : [node["assign-agent-name"]],
      ),
    ),
  ];
  if (
    !themes.some(
      (theme) =>
        theme.kind === kind &&
        lists.every((list) => namesForThemeList(theme, list) !== undefined),
    )
  ) {
    throw new BlueprintValidationError(
      `Blueprint '${artifactId}' requires ${kind} agent-name lists ${JSON.stringify(lists.sort())}, but no theme provides them`,
    );
  }
};

export const validateBlueprintRepository = async (
  repositoryRoot: string,
): Promise<string[]> => {
  const root = resolve(repositoryRoot);
  const themes = await validateAgentNameThemeRepository(root);
  const directory = join(root, "blueprints");
  const filenames = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name) === ".json")
    .map(({ name }) => name)
    .sort();
  if (filenames.length === 0) {
    throw new BlueprintValidationError(
      "Blueprint repository must contain at least one JSON artifact",
    );
  }
  const schema = await json(schemaPath);
  const validator = new Ajv2020({ allErrors: true, strict: false }).compile(
    schema as object,
  );
  for (const filename of filenames) {
    const artifactId = basename(filename, ".json");
    if (!isBlueprintArtifactId(artifactId)) {
      throw new BlueprintValidationError(
        `Blueprint filename '${filename}' must be a kebab artifact ID`,
      );
    }
    const artifact = await json(join(directory, filename));
    if (!validator(artifact)) {
      throw new BlueprintValidationError(
        `Blueprint '${artifactId}' violates the lifecycle schema: ${JSON.stringify(validator.errors)}`,
      );
    }
    const blueprint = {
      ...(artifact as Record<string, unknown>),
      id: artifactId,
    } as LifecycleBlueprint;
    validateBlueprint(blueprint, effectCatalog(blueprint));
    assertAgentNameThemeAvailability(artifactId, blueprint, themes);
    assertTemplateRelationships(
      artifactId,
      artifact as Record<string, unknown>,
      blueprint,
    );
    await assertTemplateArtifacts(artifactId, blueprint.nodes, root);
    await assertOutputContractArtifacts(artifactId, blueprint, root);
  }
  const artifacts = filenames.map((filename) => basename(filename, ".json"));
  const adjudicationPath = join(root, "adjudication", "policy.json");
  const adjudication = await stat(adjudicationPath).catch(() => undefined);
  if (adjudication !== undefined) {
    if (!adjudication.isFile()) {
      throw new BlueprintValidationError(
        "Adjudication policy must be a JSON file",
      );
    }
    const adjudicationValidator = new Ajv2020({
      allErrors: true,
      strict: false,
    }).compile((await json(adjudicationSchemaPath)) as object);
    if (!adjudicationValidator(await json(adjudicationPath))) {
      throw new BlueprintValidationError(
        `Adjudication policy violates its schema: ${JSON.stringify(adjudicationValidator.errors)}`,
      );
    }
    artifacts.push("adjudication/policy");
  }
  return artifacts;
};
