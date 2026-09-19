import { graphql } from "../generated/gql.js";

export const AddCommentDocument = graphql(`
  mutation AddComment($input: AddCommentInput!) {
    addComment(input: $input) {
      commentEdge {
        node {
          id
        }
      }
    }
  }
`);

export const AddReactionDocument = graphql(`
  mutation AddReaction($input: AddReactionInput!) {
    addReaction(input: $input) {
      reaction {
        content
      }
    }
  }
`);

export const RemoveReactionDocument = graphql(`
  mutation RemoveReaction($input: RemoveReactionInput!) {
    removeReaction(input: $input) {
      reaction {
        content
      }
    }
  }
`);

export const UpdateCommentDocument = graphql(`
  mutation UpdateComment($input: UpdateIssueCommentInput!) {
    updateIssueComment(input: $input) {
      issueComment {
        id
      }
    }
  }
`);

export const DeleteCommentDocument = graphql(`
  mutation DeleteComment($input: DeleteIssueCommentInput!) {
    deleteIssueComment(input: $input) {
      __typename
    }
  }
`);
