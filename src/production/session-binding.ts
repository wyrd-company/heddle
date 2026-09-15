// ---
// relationships:
//   implements: heddle
// ---

import type {
  ResolvedProviderCandidateSelection,
  ResolvedProviderSelection,
} from "../control-plane/index.js";
import { reasoningEffortOptionSelections } from "../control-plane/index.js";
import type { T3ProviderDispatchContext } from "../control-plane/t3-control-plane-client.js";
import type { ResolvedSessionBinding } from "../persistence/index.js";
import type { SkippedProviderCandidate } from "../persistence/index.js";

export const bindResolvedSession = (
  selection: ResolvedProviderSelection | ResolvedProviderCandidateSelection,
  sessionKey: string,
  threadId: string,
  candidatePosition?: number,
  skippedCandidates?: readonly SkippedProviderCandidate[],
): ResolvedSessionBinding => {
  const candidate = selection as Partial<ResolvedProviderCandidateSelection>;
  const skipped = skippedCandidates ?? candidate.skippedCandidates ?? [];
  return {
    alias: selection.alias,
    candidatePosition: candidatePosition ?? candidate.candidatePosition ?? 1,
    driverKind: selection.driverKind,
    interactionMode: selection.interactionMode,
    modelSlug: selection.model.slug,
    observedCliVersion: selection.observedCliVersion,
    providerDisplayName: selection.providerDisplayName,
    providerInstanceId: selection.providerInstanceId,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selection.reasoningEffort }),
    ...(selection.reasoningEffortOptionId === undefined
      ? {}
      : { reasoningEffortOptionId: selection.reasoningEffortOptionId }),
    runtimeMode: selection.runtimeMode,
    sessionKey,
    skippedCandidates: skipped.map((skippedCandidate) => ({
      ...skippedCandidate,
      failure: { ...skippedCandidate.failure },
    })),
    threadId,
  };
};

export const modelSelectionFromBinding = (
  binding: ResolvedSessionBinding,
): {
  instanceId: string;
  model: string;
  options?: readonly { readonly id: string; readonly value: string }[];
} => {
  const options = reasoningEffortOptionSelections(
    binding.reasoningEffort,
    binding.reasoningEffortOptionId,
  );
  return {
    instanceId: binding.providerInstanceId,
    model: binding.modelSlug,
    ...(options.length === 0 ? {} : { options }),
  };
};

export const providerContextFromBinding = (
  binding: ResolvedSessionBinding,
): T3ProviderDispatchContext => ({
  cliVersion: binding.observedCliVersion,
  driver: binding.driverKind,
  lifecycle: "independent",
  providerInstanceId: binding.providerInstanceId,
});
