import { graphql } from "../generated/gql.js";

export const AddLabelsToLabelableDocument = graphql(`
  mutation AddLabelsToLabelable($input: AddLabelsToLabelableInput!) {
    addLabelsToLabelable(input: $input) {
      labelable {
        __typename
        ... on Issue {
          id
        }
      }
    }
  }
`);

export const RemoveLabelsFromLabelableDocument = graphql(`
  mutation RemoveLabelsFromLabelable($input: RemoveLabelsFromLabelableInput!) {
    removeLabelsFromLabelable(input: $input) {
      labelable {
        __typename
        ... on Issue {
          id
        }
      }
    }
  }
`);

export const AddAssigneesToAssignableDocument = graphql(`
  mutation AddAssigneesToAssignable($input: AddAssigneesToAssignableInput!) {
    addAssigneesToAssignable(input: $input) {
      assignable {
        __typename
        ... on Issue {
          id
        }
      }
    }
  }
`);

export const RemoveAssigneesFromAssignableDocument = graphql(`
  mutation RemoveAssigneesFromAssignable($input: RemoveAssigneesFromAssignableInput!) {
    removeAssigneesFromAssignable(input: $input) {
      assignable {
        __typename
        ... on Issue {
          id
        }
      }
    }
  }
`);
