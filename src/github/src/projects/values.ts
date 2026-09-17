import type { IssueFieldCreateOrUpdateInput, ProjectV2FieldValue } from "../generated/graphql.js";
import type { FieldValue } from "../schema/types.js";
import { SchemaMismatchError, ValidationError } from "../transport/errors.js";
import type { ProjectField } from "./fields.js";

/** One planned write for one field of one item. */
export type EncodedValue =
  | { kind: "project"; field: ProjectField; value: ProjectV2FieldValue | null }
  | { kind: "issue"; field: ProjectField; value: IssueFieldCreateOrUpdateInput };

/** Finds a field by name or throws SchemaMismatchError. */
export function fieldNamed(fields: readonly ProjectField[], name: string): ProjectField {
  const field = fields.find((f) => f.name === name);
  if (!field) throw new SchemaMismatchError([{ kind: "unknown-field", field: name }]);
  return field;
}

/**
 * Pure: turns a caller value into the wire value for its field. `null` clears.
 * Fields backed by an org issue field encode to a setIssueFieldValue entry.
 */
export function encodeValue(field: ProjectField, value: FieldValue | null): EncodedValue {
  if (field.dataType === "builtIn") {
    throw new ValidationError(`field "${field.name}" is built in and cannot be set`);
  }
  if (field.type === "issueField")
    return { kind: "issue", field, value: encodeIssue(field, value) };
  return { kind: "project", field, value: value === null ? null : encodeProject(field, value) };
}

function encodeProject(field: ProjectField, value: FieldValue): ProjectV2FieldValue {
  switch (field.dataType) {
    case "text":
      return { text: expectString(field, value) };
    case "number":
      return { number: expectNumber(field, value) };
    case "date":
      return { date: expectString(field, value) };
    case "singleSelect":
      return { singleSelectOptionId: optionId(field, expectString(field, value)) };
    case "multiSelect":
      return { multiSelectOptionIds: expectStrings(field, value).map((n) => optionId(field, n)) };
    case "iteration":
      return { iterationId: iterationId(field, value) };
    default:
      throw new ValidationError(`field "${field.name}" cannot hold a value`);
  }
}

function encodeIssue(field: ProjectField, value: FieldValue | null): IssueFieldCreateOrUpdateInput {
  const fieldId = field.issueFieldId;
  if (!fieldId) throw new ValidationError(`field "${field.name}" has no organization field`);
  if (value === null) return { fieldId, delete: true };
  switch (field.dataType) {
    case "text":
      return { fieldId, textValue: expectString(field, value) };
    case "number":
      return { fieldId, numberValue: expectNumber(field, value) };
    case "date":
      return { fieldId, dateValue: expectString(field, value) };
    case "singleSelect":
      return { fieldId, singleSelectOptionId: optionId(field, expectString(field, value)) };
    case "multiSelect":
      return {
        fieldId,
        multiSelectOptionIds: expectStrings(field, value).map((n) => optionId(field, n)),
      };
    default:
      throw new ValidationError(`field "${field.name}" cannot hold a value`);
  }
}

function optionId(field: ProjectField, name: string): string {
  const option = field.options.find((o) => o.name === name);
  if (!option) throw new ValidationError(`field "${field.name}" has no option "${name}"`);
  return option.id;
}

/** A date picks the iteration containing it; a title picks by title. */
function iterationId(field: ProjectField, value: FieldValue): string {
  if (typeof value === "object" && "title" in value) {
    const title = value.title;
    const found = field.iterations.find((i) => i.title === title);
    if (!found) throw new ValidationError(`field "${field.name}" has no iteration "${title}"`);
    return found.id;
  }
  const date = expectString(field, value);
  const time = Date.parse(`${date}T00:00:00Z`);
  const found = field.iterations.find((i) => {
    const start = Date.parse(`${i.startDate}T00:00:00Z`);
    return time >= start && time < start + i.duration * 86_400_000;
  });
  if (!found)
    throw new ValidationError(`field "${field.name}" has no iteration containing ${date}`);
  return found.id;
}

function expectString(field: ProjectField, value: FieldValue): string {
  if (typeof value !== "string") throw new ValidationError(`field "${field.name}" needs a string`);
  return value;
}

function expectNumber(field: ProjectField, value: FieldValue): number {
  if (typeof value !== "number") throw new ValidationError(`field "${field.name}" needs a number`);
  return value;
}

function expectStrings(field: ProjectField, value: FieldValue): readonly string[] {
  if (!Array.isArray(value)) throw new ValidationError(`field "${field.name}" needs a list`);
  return value;
}
