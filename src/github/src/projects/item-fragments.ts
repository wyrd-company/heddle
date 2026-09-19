import { graphql } from "../generated/gql.js";

export const FieldNameFragment = graphql(`
  fragment FieldName on ProjectV2FieldConfiguration {
    ... on ProjectV2FieldCommon {
      id
      name
    }
  }
`);

/** Every readable item value kind. Read-only kinds (labels, milestone, …) carry only the field. */
export const ItemValuePartsFragment = graphql(`
  fragment ItemValueParts on ProjectV2ItemFieldValue {
    __typename
    ... on ProjectV2ItemFieldTextValue {
      text
      field {
        ...FieldName
      }
    }
    ... on ProjectV2ItemFieldNumberValue {
      number
      field {
        ...FieldName
      }
    }
    ... on ProjectV2ItemFieldDateValue {
      date
      field {
        ...FieldName
      }
    }
    ... on ProjectV2ItemFieldSingleSelectValue {
      name
      optionId
      field {
        ...FieldName
      }
    }
    ... on ProjectV2ItemFieldIterationValue {
      iterationId
      title
      startDate
      duration
      field {
        ...FieldName
      }
    }
    ... on ProjectV2ItemFieldMultiSelectValue {
      options {
        id
        name
      }
      field {
        ...FieldName
      }
    }
    ... on ProjectV2ItemIssueFieldValue {
      field {
        ...FieldName
      }
      issueFieldValue {
        __typename
        ... on IssueFieldTextValue {
          text: value
        }
        ... on IssueFieldNumberValue {
          number: value
        }
        ... on IssueFieldDateValue {
          date: value
        }
        ... on IssueFieldSingleSelectValue {
          name
          optionId
        }
        ... on IssueFieldMultiSelectValue {
          options {
            id
            name
          }
        }
      }
    }
  }
`);

export const ItemPartsFragment = graphql(`
  fragment ItemParts on ProjectV2Item {
    id
    type
    isArchived
    content {
      __typename
      ... on Issue {
        id
        number
        title
        repository {
          nameWithOwner
        }
      }
      ... on PullRequest {
        id
        number
        title
        repository {
          nameWithOwner
        }
      }
      ... on DraftIssue {
        id
        title
      }
    }
    fieldValues(first: 50) {
      nodes {
        ...ItemValueParts
      }
    }
  }
`);
