// ---
// relationships:
//   implements: heddle
// ---

export const retainedProjectRecreationError = (
  error: unknown,
  projectId: string,
): Error =>
  new Error(
    `T3 rejected recreation of retained project identity '${projectId}' while it was absent from the active shell; T3 may retain hidden or non-active history for this identity`,
    { cause: error },
  );
