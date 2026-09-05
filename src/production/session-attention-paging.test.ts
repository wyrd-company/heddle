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

  it("contains an exact page failure and continues later pages", async () => {
    const send = vi.fn(async ({ attentionId }: { attentionId: string }) => {
      if (attentionId === "attention-ended") throw new Error("unavailable");
    });
    const containFailure = vi.fn(async () => true);

    await pageSessionAttentions(
      [attention("ended"), attention("failed")],
      { send },
      containFailure,
    );

    expect(send).toHaveBeenCalledTimes(2);
    expect(containFailure).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ attentionId: "attention-ended" }),
    );
  });

  it("propagates an uncontained page failure", async () => {
    const failure = new Error("invariant");

    await expect(
      pageSessionAttentions(
        [attention("ended")],
        { send: async () => Promise.reject(failure) },
        async () => false,
      ),
    ).rejects.toBe(failure);
  });
});
