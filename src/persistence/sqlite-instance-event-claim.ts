// ---
// relationships:
//   implements: heddle
// ---

import type {
  InstanceEventClaim,
  InstanceRecord,
  PersistedEvent,
} from "./types.js";

export type InstanceEventClaimActions = {
  appendEvent(): PersistedEvent;
  claimVersion(): boolean;
  recordStateUpdate(): void;
  requireRecord(): InstanceRecord;
};

export const claimInstanceEvent = (
  actions: InstanceEventClaimActions,
): InstanceEventClaim | undefined => {
  if (!actions.claimVersion()) {
    actions.requireRecord();
    return undefined;
  }
  actions.recordStateUpdate();
  return {
    event: actions.appendEvent(),
    record: actions.requireRecord(),
  };
};
