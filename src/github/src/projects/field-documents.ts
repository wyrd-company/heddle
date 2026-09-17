import { graphql } from "../generated/gql.js";

export const ProjectFieldsDocument = graphql(`
  query ProjectFields($id: ID!, $after: String) {
    node(id: $id) {
      ... on ProjectV2 {
        fields(first: 50, after: $after) {
          nodes {
            ...ProjectFieldParts
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

export const OwnerIssueFieldIdsDocument = graphql(`
  query OwnerIssueFieldIds($login: String!) {
    organization(login: $login) {
      issueFields(first: 100) {
        nodes {
          __typename
          ... on IssueFieldText {
            id
            name
          }
          ... on IssueFieldNumber {
            id
            name
          }
          ... on IssueFieldDate {
            id
            name
          }
          ... on IssueFieldSingleSelect {
            id
            name
          }
          ... on IssueFieldMultiSelect {
            id
            name
          }
        }
      }
    }
  }
`);

export const CreateProjectFieldDocument = graphql(`
  mutation CreateProjectField($input: CreateProjectV2FieldInput!) {
    createProjectV2Field(input: $input) {
      projectV2Field {
        ...ProjectFieldParts
      }
    }
  }
`);

export const CreateProjectIssueFieldDocument = graphql(`
  mutation CreateProjectIssueField($input: CreateProjectV2IssueFieldInput!) {
    createProjectV2IssueField(input: $input) {
      projectV2Field {
        ...ProjectFieldParts
      }
    }
  }
`);

export const UpdateProjectFieldDocument = graphql(`
  mutation UpdateProjectField($input: UpdateProjectV2FieldInput!) {
    updateProjectV2Field(input: $input) {
      projectV2Field {
        ...ProjectFieldParts
      }
    }
  }
`);

export const DeleteProjectFieldDocument = graphql(`
  mutation DeleteProjectField($input: DeleteProjectV2FieldInput!) {
    deleteProjectV2Field(input: $input) {
      clientMutationId
    }
  }
`);
