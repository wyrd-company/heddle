// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import type { JsonValue } from "../persistence/index.js";
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

const activationPayload = (
  overrides: Record<string, JsonValue> = {},
): JsonValue => ({
  format: "heddle.session-activation",
  futurePrivateField: token,
  instanceId: "instance-41",
  renderedDocument,
  sessionKey: "session-41",
  stage: "inspect",
  systemPrompt,
  taskId: 41,
  threadId: "thread-41",
  version: 1,
  ...overrides,
});

const activation = (payload: ConsoleEvent["payload"]): ConsoleEvent => ({
  instanceId: "instance-41",
  payload,
  recordedAt: "2026-01-01T00:00:00.000Z",
  sequence: 1,
  type: "session:activated",
});
const project = (event: ConsoleEvent): ConsoleEvent =>
  projectPublicConsoleEvent(event, [token]);

const expectUnavailable = (payload: JsonValue): void => {
  const publicEvent = project(activation(payload));
  expect(JSON.stringify(publicEvent)).not.toContain(token);
  expect(publicEvent.payload).toEqual({
    format: "heddle.session-activation",
    redaction: "session-activation-payload-unavailable",
    version: 1,
  });
};

describe("public console event projection", () => {
  it("fails closed when a generic event payload contains a correlation token", () => {
    expect(() =>
      project({
        instanceId: "instance-41",
        payload: { message: `Blocked by ${token}` },
        recordedAt: "2026-01-01T00:00:00.000Z",
        sequence: 1,
        type: "mcp:blocked-reported",
      }),
    ).toThrow(
      "Console data is unavailable because it contains protected session data",
    );
  });

  it.each(["instance:created", "instance:updated"])(
    "omits the secret-bearing state payload from %s",
    (type) => {
      const publicEvent = project({
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
    const publicEvent = project(
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

  it("omits an unrecognized activation field from an otherwise canonical payload", () => {
    const futurePrivateValue = "future-private-fixture";
    const publicEvent = project(
      activation({
        format: "heddle.session-activation",
        futurePrivateField: futurePrivateValue,
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

    expect(JSON.stringify(publicEvent)).not.toContain(futurePrivateValue);
    expect(publicEvent.payload).toMatchObject({
      renderedDocument: expect.stringContaining(
        "# Inspect the generated sample",
      ),
    });
  });

  it("fails closed when the thread identity contains the correlation token", () => {
    const publicEvent = project(
      activation({
        format: "heddle.session-activation",
        instanceId: "instance-41",
        renderedDocument,
        sessionKey: "session-41",
        stage: "inspect",
        systemPrompt,
        taskId: 41,
        threadId: `thread-${token}-suffix`,
        version: 1,
      }),
    );

    expect(JSON.stringify(publicEvent)).not.toContain(token);
    expect(publicEvent.payload).toEqual({
      format: "heddle.session-activation",
      redaction: "session-activation-payload-unavailable",
      version: 1,
    });
  });

  it.each([
    [
      "an array payload",
      Object.assign([], activationPayload()) as unknown as JsonValue,
    ],
    [
      "a changed activation format",
      activationPayload({ format: "fixture.changed-activation" }),
    ],
    ["an unsupported activation version", activationPayload({ version: 2 })],
    [
      "a non-string activation instance identity",
      activationPayload({
        instanceId: 41,
        renderedDocument: renderedDocument.replace(
          'instanceId: "instance-41"',
          "instanceId: 41",
        ),
      }),
    ],
    [
      "a non-string rendered document",
      activationPayload({ renderedDocument: 41 }),
    ],
    [
      "a non-string activation session identity",
      activationPayload({
        renderedDocument: renderedDocument.replace(
          'sessionKey: "session-41"',
          "sessionKey: 41",
        ),
        sessionKey: 41,
      }),
    ],
    [
      "a non-string activation stage identity",
      activationPayload({
        renderedDocument: renderedDocument.replace(
          'stage: "inspect"',
          "stage: 41",
        ),
        stage: 41,
      }),
    ],
    [
      "a non-string system prompt",
      activationPayload({
        renderedDocument: renderedDocument.replace(systemPrompt, "41"),
        systemPrompt: 41,
      }),
    ],
    [
      "a non-safe-integer task identity",
      activationPayload({
        renderedDocument: renderedDocument.replace(
          "taskId: 41",
          "taskId: 41.5",
        ),
        taskId: 41.5,
      }),
    ],
    ["a non-string thread identity", activationPayload({ threadId: 41 })],
  ])(
    "fails closed when an activation payload has %s",
    (_description, payload) => {
      expectUnavailable(payload);
    },
  );

  it.each([
    [
      "changed handoff format",
      renderedDocument.replace(
        'format: "heddle.stage-handoff"',
        'format: "fixture.changed-handoff"',
      ),
    ],
    [
      "unsupported handoff version",
      renderedDocument.replace("version: 1", "version: 2"),
    ],
    [
      "changed instance identity",
      renderedDocument.replace("instance-41", "instance-42"),
    ],
    [
      "changed session identity",
      renderedDocument.replace("session-41", "session-42"),
    ],
    [
      "changed task identity",
      renderedDocument.replace("taskId: 41", "taskId: 42"),
    ],
    [
      "changed stage identity",
      renderedDocument.replace('stage: "inspect"', 'stage: "review"'),
    ],
    [
      "changed system-prompt prefix",
      renderedDocument.replace(systemPrompt, "# Changed fixture instructions"),
    ],
    [
      "missing front-matter start",
      renderedDocument.replace("\n\n---\n", "\n\n...\n"),
    ],
    [
      "missing front-matter end",
      renderedDocument.replace("\n---\n# Inspect", "\n...\n# Inspect"),
    ],
    [
      "malformed front matter",
      renderedDocument.replace("version: 1", "version: ["),
    ],
    [
      "non-record front matter",
      `${systemPrompt}\n\n---\nnull\n---\n# Inspect the generated sample`,
    ],
    [
      "unrecognized front-matter field",
      renderedDocument.replace(
        `correlationToken: "${token}"`,
        `correlationToken: "${token}"\nfuturePrivateField: "fixture"`,
      ),
    ],
    [
      "duplicate token field",
      renderedDocument.replace(
        `correlationToken: "${token}"`,
        `correlationToken: "${token}"\ncorrelationToken: "second"`,
      ),
    ],
    [
      "whitespace in the token",
      renderedDocument.replace(token, `${token} suffix`),
    ],
    ["a non-string token", renderedDocument.replace(`"${token}"`, "41")],
    ["token copied into the body", `${renderedDocument}\n${token}`],
  ])(
    "fails closed when an activation document has %s",
    (_description, candidate) => {
      expectUnavailable(activationPayload({ renderedDocument: candidate }));
    },
  );
});
