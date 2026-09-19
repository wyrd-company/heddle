import { graphql } from "../generated/gql.js";

export const StatusUpdatePartsFragment = graphql(`
  fragment StatusUpdateParts on ProjectV2StatusUpdate {
    id
    status
    body
    startDate
    targetDate
    createdAt
  }
`);

export const ProjectStatusUpdatesDocument = graphql(`
  query ProjectStatusUpdates($id: ID!, $after: String) {
    node(id: $id) {
      ... on ProjectV2 {
        statusUpdates(first: 50, after: $after) {
          nodes {
            ...StatusUpdateParts
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

export const CreateStatusUpdateDocument = graphql(`
  mutation CreateStatusUpdate($input: CreateProjectV2StatusUpdateInput!) {
    createProjectV2StatusUpdate(input: $input) {
      statusUpdate {
        ...StatusUpdateParts
      }
    }
  }
`);

export const UpdateStatusUpdateDocument = graphql(`
  mutation UpdateStatusUpdate($input: UpdateProjectV2StatusUpdateInput!) {
    updateProjectV2StatusUpdate(input: $input) {
      statusUpdate {
        id
      }
    }
  }
`);

export const DeleteStatusUpdateDocument = graphql(`
  mutation DeleteStatusUpdate($input: DeleteProjectV2StatusUpdateInput!) {
    deleteProjectV2StatusUpdate(input: $input) {
      clientMutationId
    }
  }
`);
