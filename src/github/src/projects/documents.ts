import { graphql } from "../generated/gql.js";

/** Shape of every project field kind, including fields backed by org issue fields. */
export const ProjectFieldPartsFragment = graphql(`
  fragment ProjectFieldParts on ProjectV2FieldConfiguration {
    __typename
    ... on ProjectV2FieldCommon {
      id
      name
      dataType
      isIssueField
    }
    ... on ProjectV2Field {
      issueField {
        ...IssueFieldRef
      }
    }
    ... on ProjectV2SingleSelectField {
      options {
        id
        name
        color
        description
      }
      issueField {
        ...IssueFieldRef
      }
    }
    ... on ProjectV2MultiSelectField {
      multiSelectOptions {
        id
        name
        color
        description
      }
      issueField {
        ...IssueFieldRef
      }
    }
    ... on ProjectV2IterationField {
      configuration {
        duration
        iterations {
          id
          title
          startDate
          duration
        }
        completedIterations {
          id
          title
          startDate
          duration
        }
      }
    }
  }
`);

export const IssueFieldRefFragment = graphql(`
  fragment IssueFieldRef on IssueFields {
    __typename
    ... on IssueFieldText {
      id
    }
    ... on IssueFieldNumber {
      id
    }
    ... on IssueFieldDate {
      id
    }
    ... on IssueFieldSingleSelect {
      id
      options {
        id
        name
        color
        description
      }
    }
    ... on IssueFieldMultiSelect {
      id
      options {
        id
        name
        color
        description
      }
    }
  }
`);

export const ProjectSummaryPartsFragment = graphql(`
  fragment ProjectSummaryParts on ProjectV2 {
    id
    number
    title
    closed
    public
    url
  }
`);

export const ProjectByNumberDocument = graphql(`
  query ProjectByNumber($login: String!, $number: Int!) {
    repositoryOwner(login: $login) {
      ... on ProjectV2Owner {
        projectV2(number: $number) {
          ...ProjectSummaryParts
        }
      }
    }
  }
`);

export const ProjectsByOwnerDocument = graphql(`
  query ProjectsByOwner($login: String!, $search: String, $after: String) {
    repositoryOwner(login: $login) {
      ... on ProjectV2Owner {
        projectsV2(first: 50, after: $after, query: $search) {
          nodes {
            ...ProjectSummaryParts
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`);

export const ProjectLoadDocument = graphql(`
  query ProjectLoad($id: ID!) {
    node(id: $id) {
      ... on ProjectV2 {
        ...ProjectSummaryParts
        shortDescription
        readme
        repositories(first: 50) {
          nodes {
            nameWithOwner
          }
        }
      }
    }
  }
`);

export const CreateProjectDocument = graphql(`
  mutation CreateProject($input: CreateProjectV2Input!) {
    createProjectV2(input: $input) {
      projectV2 {
        ...ProjectSummaryParts
      }
    }
  }
`);

export const UpdateProjectDocument = graphql(`
  mutation UpdateProject($input: UpdateProjectV2Input!) {
    updateProjectV2(input: $input) {
      projectV2 {
        id
      }
    }
  }
`);

export const DeleteProjectDocument = graphql(`
  mutation DeleteProject($input: DeleteProjectV2Input!) {
    deleteProjectV2(input: $input) {
      projectV2 {
        id
      }
    }
  }
`);

export const LinkProjectRepositoryDocument = graphql(`
  mutation LinkProjectRepository($input: LinkProjectV2ToRepositoryInput!) {
    linkProjectV2ToRepository(input: $input) {
      repository {
        id
      }
    }
  }
`);

export const UnlinkProjectRepositoryDocument = graphql(`
  mutation UnlinkProjectRepository($input: UnlinkProjectV2FromRepositoryInput!) {
    unlinkProjectV2FromRepository(input: $input) {
      repository {
        id
      }
    }
  }
`);
