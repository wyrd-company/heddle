// ---
// relationships:
//   implements: heddle
// ---

import { readFileSync } from "node:fs";

import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

import type { LifecycleOutputContract } from "../engine/index.js";
import type { JsonValue } from "../persistence/index.js";

export type AdvanceOutputContract = LifecycleOutputContract;

export const incidentActionKinds = [
  "github-issue",
  "operator-escalation",
  "production-mutation",
] as const;

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
  if (contract === "incident-diagnosis" && output !== undefined) {
    const actions = output["proposedActions"];
    if (Array.isArray(actions)) {
      for (const [index, action] of actions.entries()) {
        const kind =
          typeof action === "object" &&
          action !== null &&
          !Array.isArray(action)
            ? action["kind"]
            : undefined;
        if (
          typeof kind === "string" &&
          !incidentActionKinds.includes(
            kind as (typeof incidentActionKinds)[number],
          )
        ) {
          throw new TypeError(
            `Advance disposition ${JSON.stringify(disposition)} names unknown incident action kind ${JSON.stringify(kind)} at proposedActions[${index}]`,
          );
        }
      }
    }
  }
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
