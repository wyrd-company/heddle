import type { IssueFieldCreateOrUpdateInput } from "../generated/graphql.js";
import type { IssueField } from "../owner/issue-fields.js";
import { ValidationError } from "../transport/errors.js";

/**
 * PURE: one declared value for an organization issue field, encoded for
 * setIssueFieldValue. `null` deletes the value. Option names resolve to option ids.
 */
export function encodeIssueFieldValue(
  field: IssueField,
  value: unknown,
): IssueFieldCreateOrUpdateInput {
  if (value === null) return { fieldId: field.id, delete: true };
  switch (field.type) {
    case "text":
      return { fieldId: field.id, textValue: expect(field, value, "string") };
    case "number":
      return { fieldId: field.id, numberValue: expect(field, value, "number") };
    case "date":
      return { fieldId: field.id, dateValue: expect(field, value, "string") };
    case "singleSelect":
      return {
        fieldId: field.id,
        singleSelectOptionId: optionId(field, expect(field, value, "string")),
      };
    case "multiSelect": {
      if (!Array.isArray(value)) throw invalid(field, value);
      return {
        fieldId: field.id,
        multiSelectOptionIds: value.map((v) => optionId(field, expect(field, v, "string"))),
      };
    }
    default:
      throw invalid(field, value);
  }
}

function expect<T extends "string" | "number">(
  field: IssueField,
  value: unknown,
  kind: T,
): T extends "string" ? string : number {
  if (typeof value !== kind) throw invalid(field, value);
  return value as T extends "string" ? string : number;
}

function optionId(field: IssueField, name: string): string {
  const option = field.options.find((o) => o.name === name);
  if (!option) {
    throw new ValidationError(
      `issue field "${field.name}" has no option "${name}" (known: ${field.options.map((o) => o.name).join(", ")})`,
    );
  }
  return option.id;
}

function invalid(field: IssueField, value: unknown): ValidationError {
  return new ValidationError(
    `value ${JSON.stringify(value)} is not valid for ${field.type} issue field "${field.name}"`,
  );
}
