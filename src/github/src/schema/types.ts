import type { IsoDate } from "../refs.js";

export type OptionColor =
  "GRAY" | "BLUE" | "GREEN" | "YELLOW" | "ORANGE" | "RED" | "PINK" | "PURPLE";
export type IssueTypeColor = OptionColor;
export type IssueFieldVisibility = "ORG_ONLY" | "ALL";

export type OptionSpec = string | { name: string; color?: OptionColor; description?: string };

export interface IterationSpec {
  title: string;
  startDate: IsoDate;
  duration: number;
}

/** A project field as the caller declares it. */
export type FieldSpec =
  | { type: "text" }
  | { type: "number" }
  | { type: "date" }
  | { type: "singleSelect"; options: readonly OptionSpec[] }
  | { type: "multiSelect"; options: readonly OptionSpec[] }
  | {
      type: "iteration";
      startDate: IsoDate;
      duration: number;
      iterations?: readonly IterationSpec[];
    }
  /** Project field mirroring the owner's issue field of the same name. */
  | { type: "issueField" };

interface IssueFieldCommon {
  description?: string;
  visibility?: IssueFieldVisibility;
}

/** An organization issue field as the caller declares it. */
export type IssueFieldSpecDecl =
  | ({ type: "text" } & IssueFieldCommon)
  | ({ type: "number" } & IssueFieldCommon)
  | ({ type: "date" } & IssueFieldCommon)
  | ({ type: "singleSelect"; options: readonly OptionSpec[] } & IssueFieldCommon)
  | ({ type: "multiSelect"; options: readonly OptionSpec[] } & IssueFieldCommon);

export interface ProjectSchema {
  title: string;
  fields: Record<string, FieldSpec>;
}

/** The shape of an undeclared project: every name allowed, resolved at runtime. */
export type AnyProjectSchema = ProjectSchema;

export type IssueFieldSchema = Record<string, IssueFieldSpecDecl>;

/** The empty owner schema: no declared issue fields. */
export type NoIssueFields = Record<never, IssueFieldSpecDecl>;

type OptionName<O> = O extends string ? O : O extends { name: infer N extends string } ? N : never;

/** The value a caller may write for a field spec. */
export type ValueFor<F, S extends IssueFieldSchema, K extends PropertyKey> = F extends {
  type: "text";
}
  ? string
  : F extends { type: "number" }
    ? number
    : F extends { type: "date" }
      ? IsoDate
      : F extends { type: "singleSelect"; options: infer O extends readonly OptionSpec[] }
        ? OptionName<O[number]>
        : F extends { type: "multiSelect"; options: infer O extends readonly OptionSpec[] }
          ? readonly OptionName<O[number]>[]
          : F extends { type: "iteration" }
            ? IsoDate | { title: string }
            : F extends { type: "issueField" }
              ? K extends keyof S
                ? ValueFor<S[K], S, K>
                : never
              : never;

/** Values a caller writes to a project item. `null` clears. */
export type Values<P extends ProjectSchema, S extends IssueFieldSchema> = {
  [K in keyof P["fields"]]?: ValueFor<P["fields"][K], S, K> | null;
};

/** Values read back from a project item. */
export type Snapshot<P extends ProjectSchema, S extends IssueFieldSchema> = {
  [K in keyof P["fields"]]: ValueFor<P["fields"][K], S, K> | null;
};

/** Values a caller writes to an issue's organization fields. `null` deletes. */
export type IssueFieldValues<S extends IssueFieldSchema> = {
  [K in keyof S]?: ValueFor<S[K], S, K> | null;
};

/** Runtime value union across every field kind. */
export type FieldValue = string | number | readonly string[] | { title: string };

export type FieldKind = FieldSpec["type"];
export type IssueFieldKind = IssueFieldSpecDecl["type"];
