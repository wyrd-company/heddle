import { graphql } from "../generated/gql.js";

export const IssueLoadDocument = graphql(`
  query IssueLoad($owner: String!, $repo: String!, $number: Int!, $relationshipPageSize: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        ...IssueCore
      }
    }
  }
`);

export const IssueIdDocument = graphql(`
  query IssueId($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issueOrPullRequest(number: $number) {
        __typename
        ... on Issue {
          id
        }
        ... on PullRequest {
          id
        }
      }
    }
  }
`);

export const IssueListDocument = graphql(`
  query IssueList(
    $owner: String!
    $repo: String!
    $states: [IssueState!]
    $after: String
    $relationshipPageSize: Int!
  ) {
    repository(owner: $owner, name: $repo) {
      issues(first: 100, after: $after, states: $states) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          ...IssueCore
        }
      }
    }
  }
`);

export const IssueSubIssuesPageDocument = graphql(`
  query IssueSubIssuesPage($id: ID!, $first: Int!, $after: String!) {
    node(id: $id) {
      __typename
      ... on Issue {
        subIssues(first: $first, after: $after) {
          nodes {
            ...IssueLocator
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

export const IssueBlockedByPageDocument = graphql(`
  query IssueBlockedByPage($id: ID!, $first: Int!, $after: String!) {
    node(id: $id) {
      __typename
      ... on Issue {
        blockedBy(first: $first, after: $after) {
          nodes {
            ...IssueLocator
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

export const IssueBlockingPageDocument = graphql(`
  query IssueBlockingPage($id: ID!, $first: Int!, $after: String!) {
    node(id: $id) {
      __typename
      ... on Issue {
        blocking(first: $first, after: $after) {
          nodes {
            ...IssueLocator
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

export const IssueClosedByPageDocument = graphql(`
  query IssueClosedByPage($id: ID!, $first: Int!, $after: String!) {
    node(id: $id) {
      __typename
      ... on Issue {
        closedByPullRequestsReferences(first: $first, after: $after, includeClosedPrs: true) {
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
      }
    }
  }
`);
