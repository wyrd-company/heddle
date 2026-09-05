// ---
// relationships:
//   implements: heddle
// ---

import type { SessionObservationAttention } from "../control-plane/index.js";
import type { OperatorPage } from "./durable-adapters.js";

export interface SessionAttentionPager {
  send(page: OperatorPage): Promise<void>;
}

export type SessionAttentionPageFailureHandler = (
  error: unknown,
  page: OperatorPage,
) => Promise<boolean> | boolean;

const pageableKinds = new Set<SessionObservationAttention["kind"]>([
  "ended",
  "failed",
  "stalled",
]);

export const pageSessionAttentions = async (
  attentions: readonly SessionObservationAttention[],
  pager: SessionAttentionPager,
  containFailure?: SessionAttentionPageFailureHandler,
): Promise<void> => {
  for (const attention of attentions) {
    if (!pageableKinds.has(attention.kind)) continue;
    const page = {
      attentionId: attention.attentionId,
      instanceId: attention.instanceId,
      message: attention.message,
    };
    try {
      await pager.send(page);
    } catch (error) {
      if ((await containFailure?.(error, page)) === true) continue;
      throw error;
    }
  }
};
