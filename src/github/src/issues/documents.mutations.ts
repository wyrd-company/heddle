import { graphql } from "../generated/gql.js";

export const CreateIssueDocument = graphql(`
  mutation CreateIssue($input: CreateIssueInput!) {
    createIssue(input: $input) {
      issue {
        id
        number
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

export const UpdateIssueDocument = graphql(`
  mutation UpdateIssue($input: UpdateIssueInput!) {
    updateIssue(input: $input) {
      issue {
        id
      }
    }
  }
`);

export const CloseIssueDocument = graphql(`
  mutation CloseIssue($input: CloseIssueInput!) {
    closeIssue(input: $input) {
      issue {
        id
        state
        stateReason
      }
    }
  }
`);

export const ReopenIssueDocument = graphql(`
  mutation ReopenIssue($input: ReopenIssueInput!) {
    reopenIssue(input: $input) {
      issue {
        id
        state
      }
    }
  }
`);

export const UnmarkIssueAsDuplicateDocument = graphql(`
  mutation UnmarkIssueAsDuplicate($input: UnmarkIssueAsDuplicateInput!) {
    unmarkIssueAsDuplicate(input: $input) {
      duplicate {
        __typename
        ... on Issue {
          id
        }
      }
    }
  }
`);

export const AddSubIssueDocument = graphql(`
  mutation AddSubIssue($input: AddSubIssueInput!) {
    addSubIssue(input: $input) {
      issue {
        id
      }
      subIssue {
        id
      }
    }
  }
`);

export const RemoveSubIssueDocument = graphql(`
  mutation RemoveSubIssue($input: RemoveSubIssueInput!) {
    removeSubIssue(input: $input) {
      issue {
        id
      }
      subIssue {
        id
      }
    }
  }
`);

export const ReprioritizeSubIssueDocument = graphql(`
  mutation ReprioritizeSubIssue($input: ReprioritizeSubIssueInput!) {
    reprioritizeSubIssue(input: $input) {
      issue {
        id
      }
    }
  }
`);

export const AddBlockedByDocument = graphql(`
  mutation AddBlockedBy($input: AddBlockedByInput!) {
    addBlockedBy(input: $input) {
      issue {
        id
      }
    }
  }
`);

export const RemoveBlockedByDocument = graphql(`
  mutation RemoveBlockedBy($input: RemoveBlockedByInput!) {
    removeBlockedBy(input: $input) {
      issue {
        id
      }
    }
  }
`);

export const AddCloseIssueReferencesDocument = graphql(`
  mutation AddCloseIssueReferences($input: AddCloseIssueReferencesInput!) {
    addCloseIssueReferences(input: $input) {
      issue {
        id
      }
    }
  }
`);

export const RemoveCloseIssueReferencesDocument = graphql(`
  mutation RemoveCloseIssueReferences($input: RemoveCloseIssueReferencesInput!) {
    removeCloseIssueReferences(input: $input) {
      issue {
        id
      }
    }
  }
`);

export const SetIssueFieldValueDocument = graphql(`
  mutation SetIssueFieldValue($input: SetIssueFieldValueInput!) {
    setIssueFieldValue(input: $input) {
      issue {
        id
      }
    }
  }
`);
