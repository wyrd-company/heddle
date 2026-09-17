import { graphql } from "../generated/gql.js";

export const OwnerLoadDocument = graphql(`
  query OwnerLoad($login: String!) {
    repositoryOwner(login: $login) {
      __typename
      id
      login
    }
  }
`);

export const IssueTypesListDocument = graphql(`
  query IssueTypesList($login: String!, $after: String) {
    organization(login: $login) {
      issueTypes(first: 100, after: $after) {
        nodes {
          id
          name
          description
          color
          isEnabled
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`);

export const IssueFieldsListDocument = graphql(`
  query IssueFieldsList($login: String!, $after: String) {
    organization(login: $login) {
      issueFields(first: 100, after: $after) {
        nodes {
          __typename
          ... on IssueFieldSingleSelect {
            id
            name
            description
            visibility
            dataType
            options {
              id
              name
              color
              description
            }
          }
          ... on IssueFieldMultiSelect {
            id
            name
            description
            visibility
            dataType
            options {
              id
              name
              color
              description
            }
          }
          ... on IssueFieldText {
            id
            name
            description
            visibility
            dataType
          }
          ... on IssueFieldNumber {
            id
            name
            description
            visibility
            dataType
          }
          ... on IssueFieldDate {
            id
            name
            description
            visibility
            dataType
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`);

export const CreateIssueTypeDocument = graphql(`
  mutation CreateIssueType($input: CreateIssueTypeInput!) {
    createIssueType(input: $input) {
      issueType {
        id
        name
        description
        color
        isEnabled
      }
    }
  }
`);

export const UpdateIssueTypeDocument = graphql(`
  mutation UpdateIssueType($input: UpdateIssueTypeInput!) {
    updateIssueType(input: $input) {
      issueType {
        id
        name
        description
        color
        isEnabled
      }
    }
  }
`);

export const DeleteIssueTypeDocument = graphql(`
  mutation DeleteIssueType($input: DeleteIssueTypeInput!) {
    deleteIssueType(input: $input) {
      clientMutationId
    }
  }
`);

export const CreateIssueFieldDocument = graphql(`
  mutation CreateIssueField($input: CreateIssueFieldInput!) {
    createIssueField(input: $input) {
      issueField {
        __typename
        ... on IssueFieldSingleSelect {
          id
          name
          description
          visibility
          dataType
          options {
            id
            name
            color
            description
          }
        }
        ... on IssueFieldMultiSelect {
          id
          name
          description
          visibility
          dataType
          options {
            id
            name
            color
            description
          }
        }
        ... on IssueFieldText {
          id
          name
          description
          visibility
          dataType
        }
        ... on IssueFieldNumber {
          id
          name
          description
          visibility
          dataType
        }
        ... on IssueFieldDate {
          id
          name
          description
          visibility
          dataType
        }
      }
    }
  }
`);

export const UpdateIssueFieldDocument = graphql(`
  mutation UpdateIssueField($input: UpdateIssueFieldInput!) {
    updateIssueField(input: $input) {
      issueField {
        __typename
        ... on IssueFieldSingleSelect {
          id
          name
          description
          visibility
          dataType
          options {
            id
            name
            color
            description
          }
        }
        ... on IssueFieldMultiSelect {
          id
          name
          description
          visibility
          dataType
          options {
            id
            name
            color
            description
          }
        }
        ... on IssueFieldText {
          id
          name
          description
          visibility
          dataType
        }
        ... on IssueFieldNumber {
          id
          name
          description
          visibility
          dataType
        }
        ... on IssueFieldDate {
          id
          name
          description
          visibility
          dataType
        }
      }
    }
  }
`);

export const DeleteIssueFieldDocument = graphql(`
  mutation DeleteIssueField($input: DeleteIssueFieldInput!) {
    deleteIssueField(input: $input) {
      clientMutationId
    }
  }
`);
