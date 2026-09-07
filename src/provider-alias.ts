// ---
// relationships:
//   implements: heddle
// ---

export const providerAliasPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const isProviderAlias = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 64 &&
  providerAliasPattern.test(value);
