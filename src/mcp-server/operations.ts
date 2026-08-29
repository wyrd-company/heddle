// ---
// relationships:
//   implements: heddle
// ---

export const advanceOperationId = (sessionKey: string): string =>
  `mcp:advance:${sessionKey}`;
