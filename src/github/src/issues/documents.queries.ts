import { graphql } from "../generated/gql.js";

export const IssueLoadDocument = graphql(`
  query IssueLoad($owner: String!, $repo: String!, $number: Int!) {
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
  query IssueList($owner: String!, $repo: String!, $states: [IssueState!], $after: String) {
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
