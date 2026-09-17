// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import {
  declaredPath,
  incompatibleSchema,
  objectSchema,
  schemaAtPath,
  schemaErrors,
} from "./output-schemas.js";
import { isObject } from "./schema-validation.js";
import type {
  Blueprint,
  JsonObject,
  LoadedBlueprint,
  ValidationFinding,
} from "./types.js";

type BlueprintInventory = ReadonlyMap<string, readonly LoadedBlueprint[]>;
interface ContractBlueprint extends LoadedBlueprint {
  readonly inventory: BlueprintInventory;
}

function handoffSchema(file: string, value: unknown): JsonObject {
  if (isObject(value)) return value;
  if (typeof value === "string") {
    try {
      const directory = realpathSync(dirname(file));
      const path = realpathSync(resolve(directory, value));
      const local = relative(directory, path);
      if (isAbsolute(value) || local === ".." || local.startsWith(`..${sep}`))
        return {};
      const schema: unknown = parse(readFileSync(path, "utf8"));
      if (isObject(schema)) return schema;
    } catch {
      /* File-local reference validation reports unreadable schemas. */
    }
  }
  return {};
}

function nodeSchema(
  loaded: ContractBlueprint,
  id: string,
  visiting: ReadonlySet<string>,
): JsonObject | undefined {
  if (visiting.has(id)) return undefined;
  const node = loaded.blueprint.nodes[id];
  if (node === undefined) return loaded.blueprint.inputs?.[id];
  const next = new Set([...visiting, id]);
  if (node.uses === "pass") {
    return {
      type: "object",
      properties: {
        payload: {
          anyOf: [
            handoffSchema(loaded.filePath, node.params?.["handoff"]),
            { type: "null" },
          ],
        },
        handoff: { type: "boolean" },
        overridden: { type: "boolean" },
        turnEnded: { type: "boolean" },
        timeout: { type: "boolean" },
        idle: { type: "boolean" },
        escalate: { type: "boolean" },
      },
    };
  }
  if (node.uses === "terminal-result")
    return valueSchema(loaded, node.params?.["value"], next);
  if (node.uses === "child-run") {
    const target = node.params?.["blueprint"];
    const matches =
      typeof target === "string" ? loaded.inventory.get(target) : undefined;
    const outputs =
      matches?.length === 1 ? (matches[0]?.blueprint.outputs ?? {}) : {};
    const mapping =
      node.params?.["outputs"] ??
      Object.fromEntries(Object.keys(outputs).map((key) => [key, key]));
    const properties: Record<string, JsonObject> = Object.create(
      null,
    ) as Record<string, JsonObject>;
    if (isObject(mapping))
      for (const [key, expression] of Object.entries(mapping)) {
        const path =
          node.params?.["outputs"] === undefined
            ? [key]
            : typeof expression === "string"
              ? declaredPath(expression)
              : undefined;
        const schema = path?.[0] === undefined ? undefined : outputs[path[0]];
        properties[key] =
          schema === undefined || path === undefined
            ? {}
            : (schemaAtPath(schema, path.slice(1)) ?? {});
      }
    return {
      type: "object",
      properties: {
        payload: objectSchema(properties),
        completed: { type: "boolean" },
        failed: { type: "boolean" },
      },
    };
  }
  if (node.uses === "aggregate" && isObject(node.params?.["bindings"])) {
    const properties: Record<string, JsonObject> = {};
    for (const [key, binding] of Object.entries(node.params["bindings"])) {
      if (!isObject(binding) || typeof binding["node"] !== "string") continue;
      const source = nodeSchema(loaded, binding["node"], next);
      const path =
        typeof binding["path"] === "string"
          ? declaredPath(binding["path"])
          : [];
      properties[key] =
        source === undefined || path === undefined
          ? {}
          : (schemaAtPath(source, path) ?? {});
    }
    return objectSchema(properties);
  }
  // Pausing node envelopes are objects; their event payload is adapter-owned.
  if (
    [
      "question",
      "on-issue-change",
      "wait",
      "sleep",
      "lifecycle-start",
    ].includes(node.uses)
  )
    return { type: "object", properties: { payload: {} } };
  return undefined;
}

function valueSchema(
  loaded: ContractBlueprint,
  value: unknown,
  visiting: ReadonlySet<string> = new Set(),
): JsonObject | undefined {
  if (!containsReference(value)) return { const: value };
  if (
    isObject(value) &&
    Object.keys(value).length === 1 &&
    typeof value["from"] === "string"
  ) {
    const path = declaredPath(value["from"]);
    if (path?.[0] === undefined) return undefined;
    const source = nodeSchema(loaded, path[0], visiting);
    return source === undefined
      ? undefined
      : schemaAtPath(source, path.slice(1));
  }
  if (Array.isArray(value))
    return {
      type: "array",
      items: {
        anyOf: value.map((item) => valueSchema(loaded, item, visiting) ?? {}),
      },
    };
  if (isObject(value))
    return objectSchema(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          valueSchema(loaded, item, visiting) ?? {},
        ]),
      ),
    );
  return { const: value };
}

function containsReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsReference);
  if (!isObject(value)) return false;
  if (Object.keys(value).length === 1 && typeof value["from"] === "string")
    return true;
  return Object.values(value).some(containsReference);
}

export function completionContractFindings(
  loaded: LoadedBlueprint,
  inventory: BlueprintInventory,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const blueprint: Blueprint = loaded.blueprint;
  for (const [key, schema] of Object.entries(blueprint.outputs ?? {})) {
    for (const message of schemaErrors(schema))
      findings.push({
        file: loaded.filePath,
        node: "$blueprint",
        rule: "repository.output-schema",
        message: `Blueprint ${blueprint.id} output ${key}: ${message}`,
      });
  }
  const result = blueprint.outputs?.["result"];
  if (result === undefined) return findings;
  for (const [id, node] of Object.entries(blueprint.nodes)) {
    if (node.uses !== "terminal-result") continue;
    const source = valueSchema(
      { ...loaded, inventory },
      node.params?.["value"],
    );
    if (source !== undefined && incompatibleSchema(source, result))
      findings.push({
        file: loaded.filePath,
        node: id,
        rule: "repository.output-shape",
        message: `Blueprint ${blueprint.id} terminal ${id} value is incompatible with declared outputs.result`,
      });
  }
  return findings;
}
