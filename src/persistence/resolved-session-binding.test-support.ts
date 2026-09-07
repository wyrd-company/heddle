// ---
// relationships:
//   verifies: heddle
// ---

import type { ResolvedSessionBinding } from "./types.js";

export const resolvedSessionBindingFixture = (
  input: Pick<ResolvedSessionBinding, "sessionKey" | "threadId"> &
    Partial<ResolvedSessionBinding>,
): ResolvedSessionBinding => ({
  alias: "sample-selection",
  driverKind: "sample-driver",
  interactionMode: "default",
  modelSlug: "sample-model",
  observedCliVersion: "sample-version",
  providerDisplayName: "Sample Workbench",
  providerInstanceId: "sample-provider",
  runtimeMode: "auto",
  ...input,
});
