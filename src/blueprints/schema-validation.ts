// ---
// relationships:
//   implements:
//     - blueprint-authoring
//     - node-types
// ---
import { existsSync, readFileSync } from "node:fs";

import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import { parse } from "yaml";

import { isNodeTypeName, NODE_TYPE_REGISTRY } from "./node-types.js";
import type { JsonObject } from "./types.js";

const schemaPath = [
  new URL("../docs/specifications/blueprint.schema.yml", import.meta.url),
  new URL("../../docs/specifications/blueprint.schema.yml", import.meta.url),
].find((candidate) => existsSync(candidate));
if (schemaPath === undefined) {
  throw new Error("The packaged blueprint schema is missing.");
}
const blueprintSchema = parse(readFileSync(schemaPath, "utf8")) as AnySchema;
const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
});
ajv.addSchema(blueprintSchema);

const registeredBlueprintValidator = ajv.getSchema(
  "https://heddle.wyrd.company/schemas/blueprint",
);
if (registeredBlueprintValidator === undefined) {
  throw new Error("The blueprint schema did not register its $id.");
}
const blueprintValidator: ValidateFunction = registeredBlueprintValidator;

const parameterValidators = new Map<string, ValidateFunction>();

export function validateBlueprintSchema(value: unknown): {
  readonly errors: readonly ErrorObject[];
  readonly valid: boolean;
} {
  const valid = blueprintValidator(value);
  return { errors: blueprintValidator.errors ?? [], valid };
}

export function validateNodeParams(
  nodeType: string,
  params: unknown,
): { readonly errors: readonly ErrorObject[]; readonly valid: boolean } {
  if (!isNodeTypeName(nodeType)) {
    return { errors: [], valid: false };
  }

  let validator = parameterValidators.get(nodeType);
  if (validator === undefined) {
    validator = ajv.compile(NODE_TYPE_REGISTRY[nodeType].paramsSchema);
    parameterValidators.set(nodeType, validator);
  }

  const activeValidator = validator;
  const valid = activeValidator(params ?? {});
  return { errors: activeValidator.errors ?? [], valid };
}

export function checkJsonSchema(schema: unknown): string[] {
  if (!isObject(schema)) {
    return ["must be a JSON Schema object"];
  }

  const messages: string[] = [];
  const schemaAjv = new Ajv2020({ strict: false, validateFormats: false });
  if (!schemaAjv.validateSchema(schema)) {
    messages.push(
      ...(schemaAjv.errors ?? []).map(
        (error) => `is not a valid JSON Schema: ${error.message ?? "error"}`,
      ),
    );
  }
  if (schema["type"] !== "object") {
    messages.push("root type must be object");
  }
  if (!isObject(schema["properties"])) {
    messages.push("root properties must be present");
  }
  if (
    typeof schema["description"] !== "string" ||
    schema["description"].trim().length === 0
  ) {
    messages.push("root description must be non-empty");
  }
  return messages;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
