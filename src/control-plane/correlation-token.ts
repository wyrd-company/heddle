// ---
// relationships:
//   implements: heddle
// ---

import type { InstanceRecord, InstanceState } from "../persistence/index.js";

export interface InstanceStateStore {
  compareAndSwapInstance(
    instanceId: string,
    expectedVersion: number,
    state: InstanceState,
  ): InstanceRecord | undefined;
  getInstance(instanceId: string): InstanceRecord | undefined;
  listInstances(): InstanceRecord[];
}

export type CorrelationTokenResult = {
  record: InstanceRecord;
  token: string;
};

const isRegistrationToken = (value: string): boolean =>
  /^\S{1,8192}$/u.test(value);

export const ensureCorrelationToken = (
  store: InstanceStateStore,
  instanceId: string,
  sessionKey: string,
  mint: () => string = () => globalThis.crypto.randomUUID(),
): CorrelationTokenResult => {
  if (sessionKey.trim() === "") {
    throw new TypeError("sessionKey must not be empty");
  }

  let candidate: string | undefined;
  while (true) {
    const current = store.getInstance(instanceId);
    if (current === undefined) {
      throw new Error(`Instance does not exist: ${instanceId}`);
    }
    const existing = current.state.correlationTokens[sessionKey];
    if (existing !== undefined) {
      if (!isRegistrationToken(existing)) {
        throw new Error(
          `Instance '${instanceId}' has an invalid correlation token for '${sessionKey}'`,
        );
      }
      return { record: current, token: existing };
    }

    candidate ??= mint();
    if (!isRegistrationToken(candidate)) {
      throw new TypeError(
        "Minted correlation token must be 1 to 8192 non-whitespace characters",
      );
    }
    const claimed = store.compareAndSwapInstance(instanceId, current.version, {
      ...current.state,
      correlationTokens: {
        ...current.state.correlationTokens,
        [sessionKey]: candidate,
      },
    });
    if (claimed !== undefined) return { record: claimed, token: candidate };
  }
};
