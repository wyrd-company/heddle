// Re-export all documents from split files
export * from "./documents.queries.js";
export * from "./documents.mutations.js";
export * from "./documents.reviews.js";

// Aliases for pulls-specific close reference mutations
export {
  AddPullCloseReferencesDocument as AddCloseIssueReferencesDocument,
  RemovePullCloseReferencesDocument as RemoveCloseIssueReferencesDocument,
} from "./documents.mutations.js";
