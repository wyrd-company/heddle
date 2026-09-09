// ---
// relationships:
//   implements: heddle
// ---

import type { ResolvedProviderSelection } from "../control-plane/index.js";
import type { T3ProviderDispatchContext } from "../control-plane/t3-control-plane-client.js";
import type { ResolvedSessionBinding } from "../persistence/index.js";
import type { SkippedProviderCandidate } from "../persistence/index.js";

export const bindResolvedSession = (
  selection: ResolvedProviderSelection,
  sessionKey: string,
  threadId: string,
  candidatePosition = 1,
  skippedCandidates: readonly SkippedProviderCandidate[] = [],
): ResolvedSessionBinding => ({
  alias: selection.alias,
  candidatePosition,
  driverKind: selection.driverKind,
  interactionMode: selection.interactionMode,
  modelSlug: selection.model.slug,
  observedCliVersion: selection.observedCliVersion,
  providerDisplayName: selection.providerDisplayName,
  providerInstanceId: selection.providerInstanceId,
  runtimeMode: selection.runtimeMode,
  sessionKey,
  skippedCandidates: skippedCandidates.map((candidate) => ({
    ...candidate,
    failure: { ...candidate.failure },
  })),
  threadId,
});

export const modelSelectionFromBinding = (
  binding: ResolvedSessionBinding,
): { instanceId: string; model: string } => ({
  instanceId: binding.providerInstanceId,
  model: binding.modelSlug,
});

export const providerContextFromBinding = (
  binding: ResolvedSessionBinding,
): T3ProviderDispatchContext => ({
  cliVersion: binding.observedCliVersion,
  driver: binding.driverKind,
  lifecycle: "independent",
  providerInstanceId: binding.providerInstanceId,
});
