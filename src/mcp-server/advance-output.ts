// ---
// relationships:
//   implements: heddle
// ---

import { readFileSync } from "node:fs";

import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

import type { JsonValue } from "../persistence/index.js";

export type AdvanceOutputContract = "optional" | "review-findings";

const schema = JSON.parse(
  readFileSync(
    new globalThis.URL("../../schemas/advance-output.json", import.meta.url),
    "utf8",
  ),
) as object;
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
  schema,
);

const validationMessage = (errors: ErrorObject[] | null | undefined): string =>
  (errors ?? [])
    .filter(({ keyword }) => keyword !== "oneOf")
    .map(({ instancePath, message }) => `${instancePath || "input"} ${message}`)
    .join("; ");

export const assertAdvanceOutput = (
  disposition: string,
  contract: AdvanceOutputContract,
  output: Record<string, JsonValue> | undefined,
): void => {
  const candidate = {
    contract,
    ...(output === undefined ? {} : { output }),
  };
  if (validate(candidate)) return;
  const detail = validationMessage(validate.errors);
  throw new TypeError(
    `Advance disposition ${JSON.stringify(disposition)} requires output contract ${JSON.stringify(contract)}${detail === "" ? "" : `: ${detail}`}`,
  );
};
