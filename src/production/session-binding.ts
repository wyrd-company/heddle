// ---
// relationships:
//   implements: heddle
// ---

import type { ResolvedProviderSelection } from "../control-plane/index.js";
import type { T3ProviderDispatchContext } from "../control-plane/t3-control-plane-client.js";
import type { ResolvedSessionBinding } from "../persistence/index.js";

export const bindResolvedSession = (
  selection: ResolvedProviderSelection,
  sessionKey: string,
  threadId: string,
): ResolvedSessionBinding => ({
  alias: selection.alias,
  driverKind: selection.driverKind,
  interactionMode: selection.interactionMode,
  modelSlug: selection.model.slug,
  observedCliVersion: selection.observedCliVersion,
  providerDisplayName: selection.providerDisplayName,
  providerInstanceId: selection.providerInstanceId,
  runtimeMode: selection.runtimeMode,
  sessionKey,
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
