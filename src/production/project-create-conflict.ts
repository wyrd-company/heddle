// ---
// relationships:
//   implements: heddle
// ---

import { describeError } from "../error-details.js";

export const classifyRetainedProjectCreateError = (
  error: unknown,
  projectId: string,
): unknown => {
  const conflict = `Project '${projectId}' already exists and cannot be created twice.`;
  if (!describeError(error).includes(conflict)) return error;
  return new Error(
    `T3 retains a deleted project with this identity (${projectId}); project recreation is unavailable`,
    { cause: error },
  );
};
