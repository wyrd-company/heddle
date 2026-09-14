// ---
// relationships:
//   implements: heddle
// ---

import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";

import type { JsonValue } from "../persistence/index.js";

export type AdvanceOutputContract = {
  name: string;
  schema: JsonValue;
};

// One Ajv instance compiles every contract; the cache is keyed by schema text
// so the same contract validates through one compiled function and holds one
// entry per distinct pinned contract rather than an Ajv instance per entry.
const ajv = new Ajv2020({ allErrors: true, strict: false });
const compiled = new Map<string, ValidateFunction>();

const validatorFor = (contract: AdvanceOutputContract): ValidateFunction => {
  const key = JSON.stringify(contract.schema);
  let validate = compiled.get(key);
  if (validate === undefined) {
    validate = ajv.compile(contract.schema as object);
    compiled.set(key, validate);
  }
  return validate;
};

const validationMessage = (errors: ErrorObject[] | null | undefined): string =>
  (errors ?? [])
    .filter(({ keyword }) => keyword !== "oneOf")
    .map(
      ({ instancePath, message }) => `${instancePath || "output"} ${message}`,
    )
    .join("; ");

/**
 * Validates an `advance` output against the disposition's pinned output
 * contract. What a contract does not declare cannot be in the output, so a
 * disposition without a contract accepts an empty output or none.
 */
export const assertAdvanceOutput = (
  disposition: string,
  contract: AdvanceOutputContract | undefined,
  output: Record<string, JsonValue> | undefined,
): void => {
  if (contract === undefined) {
    const undeclared = Object.keys(output ?? {});
    if (undeclared.length > 0) {
      throw new TypeError(
        `Advance disposition ${JSON.stringify(disposition)} declares no output contract: output must be empty, got ${undeclared.map((key) => JSON.stringify(key)).join(", ")}`,
      );
    }
    return;
  }
  // An omitted output is an empty object; the contract says whether that is
  // enough.
  const validate = validatorFor(contract);
  if (validate(output ?? {})) return;
  const detail = validationMessage(validate.errors);
  throw new TypeError(
    `Advance disposition ${JSON.stringify(disposition)} requires output contract ${JSON.stringify(contract.name)}${detail === "" ? "" : `: ${detail}`}`,
  );
};
