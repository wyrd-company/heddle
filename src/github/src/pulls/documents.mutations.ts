import { graphql } from "../generated/gql.js";

export const CreatePullRequestDocument = graphql(`
  mutation CreatePullRequest($input: CreatePullRequestInput!) {
    createPullRequest(input: $input) {
      pullRequest {
        ...PullCore
      }
    }
  }
`);

export const UpdatePullRequestDocument = graphql(`
  mutation UpdatePullRequest($input: UpdatePullRequestInput!) {
    updatePullRequest(input: $input) {
      pullRequest {
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
        closingIssuesReferences(first: 100) {
          nodes {
            number
            repository {
              owner {
                login
              }
              name
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
    }
  }
`);

export const ClosePullRequestDocument = graphql(`
  mutation ClosePullRequest($input: ClosePullRequestInput!) {
    closePullRequest(input: $input) {
      pullRequest {
        state
      }
    }
  }
`);

export const ReopenPullRequestDocument = graphql(`
  mutation ReopenPullRequest($input: ReopenPullRequestInput!) {
    reopenPullRequest(input: $input) {
      pullRequest {
        state
      }
    }
  }
`);

export const ConvertPullRequestToDraftDocument = graphql(`
  mutation ConvertPullRequestToDraft($input: ConvertPullRequestToDraftInput!) {
    convertPullRequestToDraft(input: $input) {
      pullRequest {
        isDraft
      }
    }
  }
`);

export const MarkPullRequestReadyForReviewDocument = graphql(`
  mutation MarkPullRequestReadyForReview($input: MarkPullRequestReadyForReviewInput!) {
    markPullRequestReadyForReview(input: $input) {
      pullRequest {
        isDraft
      }
    }
  }
`);

export const RequestReviewsDocument = graphql(`
  mutation RequestReviews($input: RequestReviewsInput!) {
    requestReviews(input: $input) {
      pullRequest {
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
      }
    }
  }
`);

export const AddPullCloseReferencesDocument = graphql(`
  mutation AddPullCloseReferences($input: AddCloseIssueReferencesInput!) {
    addCloseIssueReferences(input: $input) {
      clientMutationId
    }
  }
`);

export const RemovePullCloseReferencesDocument = graphql(`
  mutation RemovePullCloseReferences($input: RemoveCloseIssueReferencesInput!) {
    removeCloseIssueReferences(input: $input) {
      clientMutationId
    }
  }
`);
