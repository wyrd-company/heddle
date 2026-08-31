// ---
// relationships:
//   implements: heddle
// ---

import type { SessionObservationAttention } from "../control-plane/index.js";
import type { OperatorPage } from "./durable-adapters.js";

export interface SessionAttentionPager {
  send(page: OperatorPage): Promise<void>;
}

const pageableKinds = new Set<SessionObservationAttention["kind"]>([
  "ended",
  "failed",
  "stalled",
]);

export const pageSessionAttentions = async (
  attentions: readonly SessionObservationAttention[],
  pager: SessionAttentionPager,
): Promise<void> => {
  for (const attention of attentions) {
    if (!pageableKinds.has(attention.kind)) continue;
    await pager.send({
      attentionId: attention.attentionId,
      instanceId: attention.instanceId,
      message: attention.message,
    });
  }
};
