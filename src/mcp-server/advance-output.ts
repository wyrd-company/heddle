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

const compiled = new Map<string, ValidateFunction>();

const validatorFor = (contract: AdvanceOutputContract): ValidateFunction => {
  const key = JSON.stringify(contract.schema);
  let validate = compiled.get(key);
  if (validate === undefined) {
    validate = new Ajv2020({ allErrors: true, strict: false }).compile(
      contract.schema as object,
    );
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
 * contract. A disposition without a contract accepts any object or none.
 */
export const assertAdvanceOutput = (
  disposition: string,
  contract: AdvanceOutputContract | undefined,
  output: Record<string, JsonValue> | undefined,
): void => {
  if (contract === undefined) return;
  if (output === undefined) {
    throw new TypeError(
      `Advance disposition ${JSON.stringify(disposition)} requires output contract ${JSON.stringify(contract.name)}: output is missing`,
    );
  }
  const validate = validatorFor(contract);
  if (validate(output)) return;
  const detail = validationMessage(validate.errors);
  throw new TypeError(
    `Advance disposition ${JSON.stringify(disposition)} requires output contract ${JSON.stringify(contract.name)}${detail === "" ? "" : `: ${detail}`}`,
  );
};
