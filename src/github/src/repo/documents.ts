import { graphql } from "../generated/gql.js";

export const RepoLoadDocument = graphql(`
  query RepoLoad($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      id
      name
      nameWithOwner
      isPrivate
      defaultBranchRef {
        name
      }
      owner {
        login
      }
    }
  }
`);

export const LabelsListDocument = graphql(`
  query LabelsList($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      id
      labels(first: 100, after: $after) {
        nodes {
          id
          name
          color
          description
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`);

export const CreateLabelDocument = graphql(`
  mutation CreateLabel($input: CreateLabelInput!) {
    createLabel(input: $input) {
      label {
        id
        name
        color
        description
      }
    }
  }
`);

export const UpdateLabelDocument = graphql(`
  mutation UpdateLabel($input: UpdateLabelInput!) {
    updateLabel(input: $input) {
      label {
        id
        name
        color
        description
      }
    }
  }
`);

export const DeleteLabelDocument = graphql(`
  mutation DeleteLabel($input: DeleteLabelInput!) {
    deleteLabel(input: $input) {
      clientMutationId
    }
  }
`);
