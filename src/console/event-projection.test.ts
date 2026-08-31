// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import type { ConsoleEvent } from "./types.js";
import { projectPublicConsoleEvent } from "./event-projection.js";

const token = "opaque-fixture-credential";
const systemPrompt = "# Generic session instructions";
const renderedDocument = `${systemPrompt}\n\n---
format: "heddle.stage-handoff"
version: 1
instanceId: "instance-41"
sessionKey: "session-41"
taskId: 41
stage: "inspect"
correlationToken: "${token}"
---
# Inspect the generated sample`;

const activation = (payload: ConsoleEvent["payload"]): ConsoleEvent => ({
  instanceId: "instance-41",
  payload,
  recordedAt: "2026-01-01T00:00:00.000Z",
  sequence: 1,
  type: "session:activated",
});

describe("public console event projection", () => {
  it.each(["instance:created", "instance:updated"])(
    "omits the secret-bearing state payload from %s",
    (type) => {
      const publicEvent = projectPublicConsoleEvent({
        instanceId: "instance-41",
        payload: {
          correlationTokens: { "session-41": token },
          flowcraftContext: null,
          handoffs: [{ correlationToken: token }],
          todoState: null,
        },
        recordedAt: "2026-01-01T00:00:00.000Z",
        sequence: 1,
        type,
      });

      expect(JSON.stringify(publicEvent)).not.toContain(token);
      expect(publicEvent.payload).toEqual({
        redaction: "instance-state-payload-unavailable",
      });
    },
  );

  it("removes only the structurally bound correlation token from a canonical activation document", () => {
    const publicEvent = projectPublicConsoleEvent(
      activation({
        format: "heddle.session-activation",
        instanceId: "instance-41",
        renderedDocument,
        sessionKey: "session-41",
        stage: "inspect",
        systemPrompt,
        taskId: 41,
        threadId: "thread-41",
        version: 1,
      }),
    );
    const serialized = JSON.stringify(publicEvent);

    expect(serialized).not.toContain(token);
    expect(publicEvent.payload).toMatchObject({
      renderedDocument: expect.stringContaining(
        "# Inspect the generated sample",
      ),
      sessionKey: "session-41",
      systemPrompt,
    });
    expect(
      (publicEvent.payload as { renderedDocument: string }).renderedDocument,
    ).not.toContain("correlationToken:");
  });

  it.each([
    ["changed identity", renderedDocument.replace("taskId: 41", "taskId: 42")],
    [
      "duplicate token field",
      renderedDocument.replace(
        `correlationToken: "${token}"`,
        `correlationToken: "${token}"\ncorrelationToken: "second"`,
      ),
    ],
    ["token copied into the body", `${renderedDocument}\n${token}`],
  ])(
    "fails closed when an activation document has %s",
    (_description, candidate) => {
      const publicEvent = projectPublicConsoleEvent(
        activation({
          format: "heddle.session-activation",
          futurePrivateField: token,
          instanceId: "instance-41",
          renderedDocument: candidate,
          sessionKey: "session-41",
          stage: "inspect",
          systemPrompt,
          taskId: 41,
          threadId: "thread-41",
          version: 1,
        }),
      );

      expect(JSON.stringify(publicEvent)).not.toContain(token);
      expect(publicEvent.payload).toEqual({
        format: "heddle.session-activation",
        redaction: "session-activation-payload-unavailable",
        version: 1,
      });
    },
  );
});
