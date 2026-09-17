import { graphql } from "../generated/gql.js";

/** Everything IssueData needs, shared by the load and list queries. */
export const IssueCoreFragment = graphql(`
  fragment IssueCore on Issue {
    __typename
    id
    number
    title
    body
    state
    stateReason
    createdAt
    updatedAt
    url
    repository {
      name
      owner {
        login
      }
    }
    issueType {
      name
    }
    milestone {
      id
      number
      title
      description
      dueOn
      state
    }
    labels(first: 100) {
      nodes {
        id
        name
        color
        description
      }
    }
    assignees(first: 100) {
      nodes {
        login
      }
    }
    parent {
      ...IssueLocator
    }
    subIssues(first: $relationshipPageSize) {
      nodes {
        ...IssueLocator
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
    blockedBy(first: $relationshipPageSize) {
      nodes {
        ...IssueLocator
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
    blocking(first: $relationshipPageSize) {
      nodes {
        ...IssueLocator
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
    duplicateOf {
      ...IssueLocator
    }
    closedByPullRequestsReferences(first: $relationshipPageSize, includeClosedPrs: true) {
      nodes {
        number
        repository {
          name
          owner {
            login
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
    issueFieldValues(first: 100) {
      nodes {
        __typename
        ... on IssueFieldDateValue {
          field {
            ... on IssueFieldDate {
              name
            }
          }
          dateValue: value
        }
        ... on IssueFieldNumberValue {
          field {
            ... on IssueFieldNumber {
              name
            }
          }
          numberValue: value
        }
        ... on IssueFieldTextValue {
          field {
            ... on IssueFieldText {
              name
            }
          }
          textValue: value
        }
        ... on IssueFieldSingleSelectValue {
          field {
            ... on IssueFieldSingleSelect {
              name
            }
          }
          optionName: name
        }
        ... on IssueFieldMultiSelectValue {
          field {
            ... on IssueFieldMultiSelect {
              name
            }
          }
          options {
            name
          }
        }
      }
    }
  }
`);

export const IssueLocatorFragment = graphql(`
  fragment IssueLocator on Issue {
    id
    number
    repository {
      name
      owner {
        login
      }
    }
  }
`);

export const CommentListDocument = graphql(`
  query CommentList($subjectId: ID!, $after: String) {
    node(id: $subjectId) {
      __typename
      ... on Issue {
        comments(first: 100, after: $after) {
          ...CommentPage
        }
      }
      ... on PullRequest {
        comments(first: 100, after: $after) {
          ...CommentPage
        }
      }
    }
  }
`);

export const CommentPageFragment = graphql(`
  fragment CommentPage on IssueCommentConnection {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      __typename
      id
      body
      author {
        login
      }
      createdAt
      updatedAt
    }
  }
`);

export const UserDocument = graphql(`
  query User($login: String!) {
    user(login: $login) {
      id
    }
  }
`);

export const TeamIdDocument = graphql(`
  query TeamId($org: String!, $slug: String!) {
    organization(login: $org) {
      team(slug: $slug) {
        id
      }
    }
  }
`);
