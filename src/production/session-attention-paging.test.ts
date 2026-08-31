// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it, vi } from "vitest";

import type { SessionObservationAttention } from "../control-plane/index.js";
import { pageSessionAttentions } from "./session-attention-paging.js";

const attention = (
  kind: SessionObservationAttention["kind"],
): SessionObservationAttention => ({
  attentionId: `attention-${kind}`,
  instanceId: "task-31",
  kind,
  message: `Sample session is ${kind}`,
  ...(kind === "approval" || kind === "user-input"
    ? { requestId: `request-${kind}` }
    : {}),
  sessionKey: "sample-session",
  threadId: "sample-thread",
});

describe("session attention paging", () => {
  it("pages ended, failed, and stalled sessions but keeps interactive attention console-only", async () => {
    const send = vi.fn(async () => undefined);

    await pageSessionAttentions(
      [
        attention("approval"),
        attention("ended"),
        attention("failed"),
        attention("stalled"),
        attention("user-input"),
      ],
      { send },
    );

    expect(send.mock.calls.map(([page]) => page)).toEqual([
      {
        attentionId: "attention-ended",
        instanceId: "task-31",
        message: "Sample session is ended",
      },
      {
        attentionId: "attention-failed",
        instanceId: "task-31",
        message: "Sample session is failed",
      },
      {
        attentionId: "attention-stalled",
        instanceId: "task-31",
        message: "Sample session is stalled",
      },
    ]);
  });
});
