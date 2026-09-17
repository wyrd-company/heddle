// ---
// relationships:
//   verifies: github-binding-and-intake
// ---
import { github } from "../src/github/src/github.js";
import { ScriptedTransport } from "../src/github/testing.js";
import {
  wireSelectField,
  wireField,
  lastPage,
} from "../src/github/src/projects/fixtures.test-support.js";
import { GitHubError } from "../src/github/src/transport/errors.js";
const relationshipLastPage: {
  hasNextPage: boolean;
  endCursor: string | null;
} = { hasNextPage: false, endCursor: null };
export interface BindingRelation {
  id: string;
  number: number;
  repository: { name: string; owner: { login: string } };
}
export interface BindingRelationPage {
  nodes: BindingRelation[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
export interface BindingLabel {
  id: string;
  name: string;
  color: string;
  description: null;
}
export interface BindingLabelPage {
  nodes: BindingLabel[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
export const recipe = (number = 1) => ({
  __typename: "Issue",
  id: `I_${String(number)}`,
  number,
  title: "Garden soup",
  body: "<!--\n---\nservings: 4\n---\n-->\nRecipe",
  state: "OPEN",
  stateReason: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  url: "https://example.invalid/recipe",
  repository: { name: "recipes", owner: { login: "sample-owner" } },
  issueType: { name: "Recipe" },
  milestone: null,
  labels: {
    nodes: [] as {
      id: string;
      name: string;
      color: string;
      description: null;
    }[],
    pageInfo: relationshipLastPage,
  },
  assignees: { nodes: [{ login: "sample-user" }] },
  parent: null,
  subIssues: { nodes: [], pageInfo: relationshipLastPage },
  blockedBy: { nodes: [], pageInfo: relationshipLastPage },
  blocking: { nodes: [], pageInfo: relationshipLastPage },
  duplicateOf: null,
  closedByPullRequestsReferences: { nodes: [], pageInfo: relationshipLastPage },
  issueFieldValues: {
    nodes: [
      {
        __typename: "IssueFieldTextValue",
        field: { name: "Origin" },
        textValue: "Garden",
      },
    ],
  },
});
export function fixture(projectId = "P_1") {
  const labelPages = new Map<string, BindingLabelPage>();
  const relationshipPages = {
    subIssues: new Map<string, BindingRelationPage>(),
    blockedBy: new Map<string, BindingRelationPage>(),
    blocking: new Map<string, BindingRelationPage>(),
    closedByPullRequestsReferences: new Map<string, BindingRelationPage>(),
  };
  const relationshipPage = (
    field: keyof typeof relationshipPages,
    after: unknown,
  ) => {
    const page = relationshipPages[field].get(String(after));
    if (!page)
      throw new Error(`Missing ${field} fixture page after ${String(after)}`);
    return { node: { __typename: "Issue", [field]: page } };
  };
  const fields: Record<string, unknown>[] = [
    wireSelectField("F_status", "Status", [
      { id: "O_backlog", name: "Backlog" },
    ]),
    wireField("F_notes", "Notes", "TEXT"),
  ];
  const issues = [recipe()];
  const itemTypes: Record<number, string> = {};
  const values: Record<string, Record<string, unknown>> = {};
  const comments: { id: string; body: string }[] = [];
  let forbidden = false;
  let statusForbidden = false;
  const item = (number: number) => ({
    id: `C_${String(number)}`,
    type: itemTypes[number] ?? "ISSUE",
    isArchived: false,
    content: {
      __typename: "Issue",
      id: `I_${String(number)}`,
      number,
      title: "Garden soup",
      repository: { nameWithOwner: "sample-owner/recipes" },
    },
    fieldValues: {
      nodes: Object.entries(values[`C_${String(number)}`] ?? {}).map(
        ([name, value]) => ({
          __typename:
            name === "Notes"
              ? "ProjectV2ItemFieldTextValue"
              : "ProjectV2ItemFieldSingleSelectValue",
          field: { name },
          name: value,
          text: value,
        }),
      ),
    },
  });
  const transport = new ScriptedTransport({
    graphql: {
      ProjectByNumber: () => ({
        repositoryOwner: {
          projectV2: {
            id: projectId,
            number: 1,
            title: "Cookbook",
            closed: false,
            public: false,
            url: "https://example.invalid/project",
          },
        },
      }),
      ProjectFields: () => ({
        node: { fields: { nodes: fields, pageInfo: lastPage } },
      }),
      UpdateProjectField: ({ input }) => {
        const i = input as {
          fieldId: string;
          singleSelectOptions: { id?: string; name: string }[];
        };
        const f = fields.find((f) => f["id"] === i.fieldId);
        if (!f) throw new Error("Fixture field missing");
        f["options"] = i.singleSelectOptions.map((o, n) => ({
          ...o,
          id: o.id ?? `O_${String(n)}`,
          color: "GRAY",
          description: "",
        }));
        return { updateProjectV2Field: { projectV2Field: f } };
      },
      CreateProjectField: ({ input }) => {
        const i = input as {
          name: string;
          singleSelectOptions: { name: string }[];
        };
        const f = wireSelectField(
          `F_${i.name}`,
          i.name,
          i.singleSelectOptions.map((o, n) => ({ ...o, id: `N_${String(n)}` })),
        );
        fields.push(f);
        return { createProjectV2Field: { projectV2Field: f } };
      },
      ProjectItems: () => ({
        node: {
          items: {
            nodes: issues.map((i) => item(i.number)),
            pageInfo: lastPage,
          },
        },
      }),
      IssueLoad: ({ number }) => ({
        repository: { issue: issues.find((i) => i.number === number) },
      }),
      IssueLabelsPage: ({ after }) => {
        const page = labelPages.get(String(after));
        if (!page)
          throw new Error(`Missing labels fixture page after ${String(after)}`);
        return { node: { __typename: "Issue", labels: page } };
      },
      IssueSubIssuesPage: ({ after }) => relationshipPage("subIssues", after),
      IssueBlockedByPage: ({ after }) => relationshipPage("blockedBy", after),
      IssueBlockingPage: ({ after }) => relationshipPage("blocking", after),
      IssueClosedByPage: ({ after }) =>
        relationshipPage("closedByPullRequestsReferences", after),
      ItemLoad: ({ id }) => ({ node: item(Number(String(id).split("_")[1])) }),
      UpdateItemFieldValue: ({ input }) => {
        if (statusForbidden)
          throw new GitHubError("FORBIDDEN", "Status write refused");
        const i = input as {
          itemId: string;
          fieldId: string;
          value: { singleSelectOptionId?: string; text?: string };
        };
        const f = fields.find((f) => f["id"] === i.fieldId);
        if (!f) throw new Error("Fixture field missing");
        const opts = f["options"] as { id: string; name: string }[] | undefined;
        const value =
          i.value.text ??
          opts?.find((o) => o.id === i.value.singleSelectOptionId)?.name;
        (values[i.itemId] ??= {})[String(f["name"])] = value;
        return {};
      },
      IssueId: () => ({
        repository: { issueOrPullRequest: { __typename: "Issue", id: "I_1" } },
      }),
      CommentList: () => ({
        node: {
          __typename: "Issue",
          comments: { nodes: comments, pageInfo: lastPage },
        },
      }),
      AddComment: ({ input }) => {
        const i = input as { body: string };
        const c = { id: `COMMENT_${String(comments.length)}`, body: i.body };
        comments.push(c);
        return { addComment: { commentEdge: { node: c } } };
      },
      LabelsList: () => ({
        repository: {
          id: "R_1",
          labels: {
            nodes: [
              {
                id: "L_1",
                name: "vegetarian",
                color: "FFFFFF",
                description: null,
              },
            ],
            pageInfo: lastPage,
          },
        },
      }),
      AddLabelsToLabelable: () => {
        const first = issues[0];
        if (!first) throw new Error("Fixture issue missing");
        first.labels.nodes.push({
          id: "L_1",
          name: "vegetarian",
          color: "FFFFFF",
          description: null,
        });
        return {};
      },
      IssueFieldsList: () => ({
        organization: {
          issueFields: {
            nodes: [
              {
                __typename: "IssueFieldText",
                id: "IF_1",
                name: "Origin",
                dataType: "TEXT",
                description: null,
                visibility: "ALL",
              },
            ],
            pageInfo: lastPage,
          },
        },
      }),
      IssueTypesList: () => ({
        organization: {
          issueTypes: {
            nodes: [
              {
                id: "IT_1",
                name: "Recipe",
                description: null,
                isEnabled: true,
                color: "GRAY",
              },
            ],
            pageInfo: lastPage,
          },
        },
      }),
      SetIssueFieldValue: () => {
        if (forbidden)
          throw new GitHubError(
            "FORBIDDEN",
            "Organization field write refused",
          );
        return {};
      },
    },
  });
  return {
    fields,
    issues,
    itemTypes,
    values,
    comments,
    labelPages,
    relationshipPages,
    transport,
    refuseStatus: () => {
      statusForbidden = true;
    },
    refuse: () => {
      forbidden = true;
    },
    clients: () =>
      github({
        auth: { appId: 1, privateKey: "unused", installationId: 1 },
        transport,
      }),
  };
}
