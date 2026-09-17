import type { IssueFieldSchema, ProjectSchema } from "./types.js";

/** Identity with a `const` type parameter: keeps field and option literals for type checking. */
export function defineProject<const P extends ProjectSchema>(schema: P): P {
  return schema;
}

/** Identity with a `const` type parameter: keeps issue field names and option literals. */
export function defineIssueFields<const S extends IssueFieldSchema>(schema: S): S {
  return schema;
}
