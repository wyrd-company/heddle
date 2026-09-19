import { graphql } from "../generated/gql.js";

export const PullCoreFragment = graphql(`
  fragment PullCore on PullRequest {
    __typename
    id
    number
    title
    body
    state
    isDraft
    headRefName
    baseRefName
    milestone {
      title
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
    reviewDecision
    reviewRequests(first: 100) {
      nodes {
        requestedReviewer {
          __typename
          ... on User {
            login
          }
          ... on Team {
            slug
          }
        }
      }
    }
    closingIssuesReferences(first: 100, userLinkedOnly: false) {
      nodes {
        number
        repository {
          name
          owner {
            login
          }
        }
      }
    }
    createdAt
    updatedAt
    url
    repository {
      owner {
        login
      }
      name
    }
  }
`);

export const ReviewThreadCoreFragment = graphql(`
  fragment ReviewThreadCore on PullRequestReviewThread {
    id
    path
    line
    originalStartLine
    diffSide
    isResolved
    isOutdated
    comments(first: 100) {
      nodes {
        id
        body
        author {
          login
        }
      }
    }
  }
`);

export const PullLoadDocument = graphql(`
  query PullLoad($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        ...PullCore
      }
    }
  }
`);

export const ListPullRequestsDocument = graphql(`
  query ListPullRequests(
    $owner: String!
    $repo: String!
    $after: String
    $state: [PullRequestState!]
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequests(first: 100, after: $after, states: $state) {
        nodes {
          ...PullCore
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`);

export const ListReviewThreadsDocument = graphql(`
  query ListReviewThreads($pullRequestId: ID!, $after: String) {
    node(id: $pullRequestId) {
      ... on PullRequest {
        reviewThreads(first: 100, after: $after) {
          nodes {
            ...ReviewThreadCore
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

export const GetMilestoneIdDocument = graphql(`
  query GetMilestoneId($owner: String!, $repo: String!, $title: String!) {
    repository(owner: $owner, name: $repo) {
      milestones(first: 100, query: $title) {
        nodes {
          id
          title
        }
      }
    }
  }
`);

export const GetLabelIdDocument = graphql(`
  query GetLabelId($owner: String!, $repo: String!, $first: Int = 100) {
    repository(owner: $owner, name: $repo) {
      labels(first: $first) {
        nodes {
          id
          name
        }
      }
    }
  }
`);

export const GetIssueIdDocument = graphql(`
  query GetIssueId($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        id
      }
    }
  }
`);

export const GetActorIdDocument = graphql(`
  query GetActorId($login: String!) {
    user(login: $login) {
      id
      login
    }
  }
`);

export const GetTeamIdDocument = graphql(`
  query GetTeamId($org: String!, $slug: String!) {
    organization(login: $org) {
      team(slug: $slug) {
        id
      }
    }
  }
`);
