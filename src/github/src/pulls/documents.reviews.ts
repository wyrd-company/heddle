import { graphql } from "../generated/gql.js";

export const AddPullRequestReviewDocument = graphql(`
  mutation AddPullRequestReview($input: AddPullRequestReviewInput!) {
    addPullRequestReview(input: $input) {
      pullRequestReview {
        id
      }
    }
  }
`);

export const UpdatePullRequestReviewDocument = graphql(`
  mutation UpdatePullRequestReview($input: UpdatePullRequestReviewInput!) {
    updatePullRequestReview(input: $input) {
      pullRequestReview {
        id
      }
    }
  }
`);

export const DismissPullRequestReviewDocument = graphql(`
  mutation DismissPullRequestReview($input: DismissPullRequestReviewInput!) {
    dismissPullRequestReview(input: $input) {
      pullRequestReview {
        id
      }
    }
  }
`);

export const AddPullRequestReviewThreadDocument = graphql(`
  mutation AddPullRequestReviewThread($input: AddPullRequestReviewThreadInput!) {
    addPullRequestReviewThread(input: $input) {
      thread {
        id
        comments(first: 1) {
          nodes {
            pullRequestReview {
              id
              state
            }
          }
        }
      }
    }
  }
`);

export const AddPullRequestReviewThreadReplyDocument = graphql(`
  mutation AddPullRequestReviewThreadReply($input: AddPullRequestReviewThreadReplyInput!) {
    addPullRequestReviewThreadReply(input: $input) {
      comment {
        id
        pullRequestReview {
          id
          state
        }
      }
    }
  }
`);

export const ResolveReviewThreadDocument = graphql(`
  mutation ResolveReviewThread($input: ResolveReviewThreadInput!) {
    resolveReviewThread(input: $input) {
      thread {
        isResolved
      }
    }
  }
`);

export const UnresolveReviewThreadDocument = graphql(`
  mutation UnresolveReviewThread($input: UnresolveReviewThreadInput!) {
    unresolveReviewThread(input: $input) {
      thread {
        isResolved
      }
    }
  }
`);

export const SubmitPullRequestReviewDocument = graphql(`
  mutation SubmitPullRequestReview($input: SubmitPullRequestReviewInput!) {
    submitPullRequestReview(input: $input) {
      pullRequestReview {
        id
        state
      }
    }
  }
`);
