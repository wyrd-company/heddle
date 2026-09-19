import { graphql } from "../generated/gql.js";

export const ItemLoadDocument = graphql(`
  query ItemLoad($id: ID!) {
    node(id: $id) {
      ... on ProjectV2Item {
        ...ItemParts
      }
    }
  }
`);

export const ProjectItemsDocument = graphql(`
  query ProjectItems($id: ID!, $after: String, $archived: [ProjectV2ItemArchivedState!]) {
    node(id: $id) {
      ... on ProjectV2 {
        items(first: 50, after: $after, archivedStates: $archived) {
          nodes {
            ...ItemParts
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

export const ItemsForContentDocument = graphql(`
  query ItemsForContent($id: ID!) {
    node(id: $id) {
      ... on Issue {
        projectItems(first: 50) {
          nodes {
            id
            project {
              id
            }
          }
        }
      }
      ... on PullRequest {
        projectItems(first: 50) {
          nodes {
            id
            project {
              id
            }
          }
        }
      }
      ... on DraftIssue {
        projectV2Items(first: 50) {
          nodes {
            id
            project {
              id
            }
          }
        }
      }
    }
  }
`);

export const IssueOrPullIdDocument = graphql(`
  query IssueOrPullId($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
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

export const AddProjectItemDocument = graphql(`
  mutation AddProjectItem($input: AddProjectV2ItemByIdInput!) {
    addProjectV2ItemById(input: $input) {
      item {
        id
      }
    }
  }
`);

export const AddProjectDraftDocument = graphql(`
  mutation AddProjectDraft($input: AddProjectV2DraftIssueInput!) {
    addProjectV2DraftIssue(input: $input) {
      projectItem {
        id
      }
    }
  }
`);

export const UpdateProjectDraftDocument = graphql(`
  mutation UpdateProjectDraft($input: UpdateProjectV2DraftIssueInput!) {
    updateProjectV2DraftIssue(input: $input) {
      draftIssue {
        id
      }
    }
  }
`);

export const ConvertDraftToIssueDocument = graphql(`
  mutation ConvertDraftToIssue($input: ConvertProjectV2DraftIssueItemToIssueInput!) {
    convertProjectV2DraftIssueItemToIssue(input: $input) {
      item {
        id
        content {
          __typename
          ... on Issue {
            id
            number
            repository {
              nameWithOwner
            }
          }
        }
      }
    }
  }
`);

export const UpdateItemFieldValueDocument = graphql(`
  mutation UpdateItemFieldValue($input: UpdateProjectV2ItemFieldValueInput!) {
    updateProjectV2ItemFieldValue(input: $input) {
      projectV2Item {
        id
      }
    }
  }
`);

export const ClearItemFieldValueDocument = graphql(`
  mutation ClearItemFieldValue($input: ClearProjectV2ItemFieldValueInput!) {
    clearProjectV2ItemFieldValue(input: $input) {
      projectV2Item {
        id
      }
    }
  }
`);

export const SetItemIssueFieldValueDocument = graphql(`
  mutation SetItemIssueFieldValue($input: SetIssueFieldValueInput!) {
    setIssueFieldValue(input: $input) {
      issue {
        id
      }
    }
  }
`);

export const ArchiveItemDocument = graphql(`
  mutation ArchiveItem($input: ArchiveProjectV2ItemInput!) {
    archiveProjectV2Item(input: $input) {
      item {
        id
      }
    }
  }
`);

export const UnarchiveItemDocument = graphql(`
  mutation UnarchiveItem($input: UnarchiveProjectV2ItemInput!) {
    unarchiveProjectV2Item(input: $input) {
      item {
        id
      }
    }
  }
`);

export const DeleteItemDocument = graphql(`
  mutation DeleteItem($input: DeleteProjectV2ItemInput!) {
    deleteProjectV2Item(input: $input) {
      deletedItemId
    }
  }
`);

export const MoveItemDocument = graphql(`
  mutation MoveItem($input: UpdateProjectV2ItemPositionInput!) {
    updateProjectV2ItemPosition(input: $input) {
      clientMutationId
    }
  }
`);
