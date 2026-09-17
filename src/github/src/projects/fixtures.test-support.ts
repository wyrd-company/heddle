import type { FieldId, NodeId } from "../refs.js";
import type { ProjectField } from "./fields.js";

/** A recipe-pipeline project's fields as the package sees them after parsing. */
export function pipelineFields(): ProjectField[] {
  return [
    field("PVTSSF_1", "Status", "singleSelect", {
      options: [opt("s1", "Idea"), opt("s2", "Drafting"), opt("s3", "Published")],
    }),
    field("PVTF_2", "Servings", "number"),
    field("PVTF_3", "Notes", "text"),
    field("PVTF_4", "Due", "date"),
    field("PVTIF_5", "Publish week", "iteration", {
      iterations: [
        { id: "it0", title: "Week 0", startDate: "2026-09-28", duration: 7, completed: true },
        { id: "it1", title: "Week 1", startDate: "2026-10-05", duration: 7, completed: false },
        { id: "it2", title: "Week 2", startDate: "2026-10-12", duration: 7, completed: false },
      ],
    }),
    field("PVTMSF_6", "Tags", "multiSelect", { options: [opt("t1", "vegan"), opt("t2", "quick")] }),
    {
      ...field("PVTSSF_7", "Priority", "singleSelect", {
        options: [opt("IFSSO_1", "Urgent"), opt("IFSSO_2", "Low")],
      }),
      type: "issueField",
      issueFieldId: "IFSS_1" as NodeId,
    },
    field("PVTF_8", "Title", "builtIn"),
  ];
}

export function field(
  id: string,
  name: string,
  kind: ProjectField["dataType"],
  extra: Partial<ProjectField> = {},
): ProjectField {
  return {
    id: id as FieldId,
    name,
    type: kind,
    dataType: kind,
    options: [],
    iterations: [],
    issueFieldId: null,
    ...extra,
  };
}

export function opt(id: string, name: string, color = "GRAY", description = "") {
  return { id, name, color, description };
}

/** Wire shape of a single-select field node as ProjectFields returns it. */
export function wireSelectField(id: string, name: string, options: { id: string; name: string }[]) {
  return {
    __typename: "ProjectV2SingleSelectField",
    id,
    name,
    dataType: "SINGLE_SELECT",
    isIssueField: false,
    issueField: null,
    options: options.map((o) => ({ ...o, color: "GRAY", description: "" })),
  };
}

export function wireField(id: string, name: string, dataType: string) {
  return {
    __typename: "ProjectV2Field",
    id,
    name,
    dataType,
    isIssueField: false,
    issueField: null,
  };
}

export const lastPage = { hasNextPage: false, endCursor: null };
