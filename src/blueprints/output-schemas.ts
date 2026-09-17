// ---
// relationships:
//   implements: blueprint-authoring
// ---
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import jsonata from "jsonata";
import { isObject } from "./schema-validation.js";
import type { JsonObject } from "./types.js";

const validators = new WeakMap<JsonObject, ValidateFunction>();
function compile(schema: JsonObject): ValidateFunction {
  const cached = validators.get(schema);
  if (cached !== undefined) return cached;
  const validator = new Ajv2020({
    strict: false,
    validateFormats: false,
    allErrors: true,
  }).compile(schema);
  validators.set(schema, validator);
  return validator;
}

/** Only plain JSONata name paths have the same meaning as schema properties. */
export function declaredPath(expression: string): string[] | undefined {
  try {
    const ast: unknown = jsonata(expression).ast();
    if (
      !isObject(ast) ||
      ast["type"] !== "path" ||
      !Array.isArray(ast["steps"])
    )
      return undefined;
    const steps = ast["steps"].filter(isObject);
    if (
      steps.some(
        (step) =>
          step["type"] !== "name" ||
          Object.keys(step).some(
            (key) => !["type", "value", "position"].includes(key),
          ),
      )
    )
      return undefined;
    return steps.map((step) => String(step["value"]));
  } catch {
    return undefined;
  }
}

function alternatives(schema: JsonObject): JsonObject[] {
  const choices = schema["anyOf"] ?? schema["oneOf"];
  return Array.isArray(choices) ? choices.filter(isObject) : [schema];
}

export function schemaAtPath(
  schema: JsonObject,
  path: readonly string[],
  root: JsonObject = schema,
  seen: ReadonlySet<string> = new Set(),
): JsonObject | undefined {
  const reference = schema["$ref"];
  if (
    typeof reference === "string" &&
    (reference === "#" || reference.startsWith("#/"))
  ) {
    const key = JSON.stringify([reference, path]);
    if (seen.has(key)) return undefined;
    let target: unknown = root;
    for (const segment of reference === "#"
      ? []
      : reference.slice(2).split("/"))
      target = isObject(target)
        ? target[segment.replaceAll("~1", "/").replaceAll("~0", "~")]
        : undefined;
    const found = isObject(target)
      ? schemaAtPath(target, path, root, new Set([...seen, key]))
      : undefined;
    if (found !== undefined) return found;
  }
  if (path.length === 0) return schema;
  if (schema["type"] === "array" && isObject(schema["items"])) {
    const member = schemaAtPath(schema["items"], path, root, seen);
    // JSONata path projection has singleton/sequence cardinality. Preserve both
    // possibilities instead of inventing a scalar or array guarantee.
    return member === undefined
      ? undefined
      : { anyOf: [member, { type: "array", items: member }] };
  }
  const [key, ...rest] = path;
  if (
    isObject(schema["const"]) &&
    key !== undefined &&
    Object.hasOwn(schema["const"], key)
  )
    return schemaAtPath({ const: schema["const"][key] }, rest, root, seen);
  const matches = [schema].flatMap((choice) => {
    const properties = choice["properties"];
    const child =
      isObject(properties) && key !== undefined ? properties[key] : undefined;
    const nested =
      child === true
        ? {}
        : isObject(child)
          ? child
          : isObject(choice["additionalProperties"])
            ? choice["additionalProperties"]
            : undefined;
    const found =
      nested === undefined ? undefined : schemaAtPath(nested, rest, root, seen);
    return found === undefined ? [] : [found];
  });
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    const choices = schema[keyword];
    if (!Array.isArray(choices)) continue;
    for (const choice of choices.filter(isObject)) {
      const found = schemaAtPath(choice, path, root, seen);
      if (found !== undefined) matches.push(found);
    }
  }
  return matches.length === 0
    ? undefined
    : matches.length === 1
      ? matches[0]
      : { anyOf: matches };
}

export function schemaErrors(schema: JsonObject): string[] {
  try {
    compile(schema);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function literalErrors(schema: JsonObject, value: unknown): string[] {
  try {
    const validate = compile(schema);
    return validate(value)
      ? []
      : (validate.errors ?? []).map(
          (error) =>
            `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
        );
  } catch {
    return []; // Invalid declarations receive their own finding.
  }
}

function schemaTypes(schema: JsonObject): string[] {
  const type = schema["type"];
  return typeof type === "string"
    ? [type]
    : Array.isArray(type)
      ? type.filter((item): item is string => typeof item === "string")
      : [];
}

/** Report only contradictions established by declarations, never guessed values. */
export function incompatibleSchema(
  source: JsonObject,
  target: JsonObject,
): boolean {
  if (Object.hasOwn(source, "const"))
    return literalErrors(target, source["const"]).length > 0;
  const sourceChoices = alternatives(source);
  const targetChoices = alternatives(target);
  if (Array.isArray(source["anyOf"]) || Array.isArray(source["oneOf"]))
    return sourceChoices.every((choice) => incompatibleSchema(choice, target));
  if (Array.isArray(target["anyOf"]) || Array.isArray(target["oneOf"]))
    return targetChoices.every((choice) => incompatibleSchema(source, choice));
  if (
    Array.isArray(target["allOf"]) &&
    target["allOf"]
      .filter(isObject)
      .some((choice) => incompatibleSchema(source, choice))
  )
    return true;
  const from = schemaTypes(source);
  const to = schemaTypes(target);
  if (
    from.length > 0 &&
    to.length > 0 &&
    from.every(
      (type) =>
        !to.includes(type) && !(type === "integer" && to.includes("number")),
    )
  )
    return true;
  const fromProperties = source["properties"];
  const toProperties = target["properties"];
  if (isObject(fromProperties) && isObject(toProperties)) {
    for (const [key, value] of Object.entries(fromProperties)) {
      const expected = toProperties[key];
      if (
        isObject(value) &&
        isObject(expected) &&
        incompatibleSchema(value, expected)
      )
        return true;
    }
    if (
      source["additionalProperties"] === false &&
      Array.isArray(target["required"]) &&
      target["required"].some(
        (key) => typeof key === "string" && !Object.hasOwn(fromProperties, key),
      )
    )
      return true;
  }
  if (isObject(source["items"]) && isObject(target["items"]))
    return incompatibleSchema(source["items"], target["items"]);
  return false;
}

export function objectSchema(
  properties: Record<string, JsonObject>,
): JsonObject {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
