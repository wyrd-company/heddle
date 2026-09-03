// ---
// relationships:
//   verifies: t3-control-plane-client
//   references: t3-headless
// ---

import { describe, expect, it, vi } from "vitest";

import {
  resolveT3AwarenessPhase,
  T3ControlPlaneClient,
  T3HttpError,
  T3PreconditionError,
  type T3ShellThread,
} from "./t3-control-plane-client.js";

const jsonResponse = (body: unknown, status = 200) =>
  new globalThis.Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("resolveT3AwarenessPhase", () => {
  it.each<[string, Partial<T3ShellThread>, string]>([
    [
      "prioritizes approval",
      { hasPendingApprovals: true, hasPendingUserInput: true },
      "waiting_for_approval",
    ],
    [
      "prioritizes user input",
      { hasPendingUserInput: true },
      "waiting_for_input",
    ],
    ["maps a failed session", { session: { status: "error" } }, "failed"],
    [
      "maps a starting session",
      { session: { status: "starting" } },
      "starting",
    ],
    ["maps a running turn", { latestTurn: { state: "running" } }, "running"],
    [
      "maps a completed turn",
      { latestTurn: { state: "completed" } },
      "completed",
    ],
    [
      "counts an interrupted turn with completedAt as completed",
      {
        latestTurn: {
          state: "interrupted",
          completedAt: "2026-01-01T00:00:00Z",
        },
      },
      "completed",
    ],
    ["maps an idle session", { session: { status: "idle" } }, "completed"],
    [
      "leaves an interrupted unfinished turn unclassified",
      { latestTurn: { state: "interrupted" } },
      "none",
    ],
  ])("%s", (_name, value, expected) => {
    expect(resolveT3AwarenessPhase({ id: "thread-1", ...value })).toBe(
      expected,
    );
  });
});

describe("T3ControlPlaneClient", () => {
  it("registers the workflow MCP endpoint and Bearer token through the authenticated provider-session route", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new globalThis.Response(undefined, { status: 204 }));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await client.registerWorkflowMcpProviderSession({
      authorizationHeader: "Bearer registration-token",
      endpoint: "http://127.0.0.1:4774/mcp",
      threadId: "thread-1",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "http://t3.test/api/mcp/provider-session",
    );
    const request = fetch.mock.calls[0]?.[1];
    expect(request?.method).toBe("PUT");
    expect(new globalThis.Headers(request?.headers).get("authorization")).toBe(
      "Bearer access-token",
    );
    expect(JSON.parse(String(request?.body))).toEqual({
      authorizationHeader: "Bearer registration-token",
      endpoint: "http://127.0.0.1:4774/mcp",
      threadId: "thread-1",
    });
  });

  it("exchanges a pairing token with the RFC 8693 fields T3 requires", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "access-token",
          token_type: "Bearer",
          expires_in: 120,
          scope: "orchestration:read orchestration:operate",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ threads: [] }));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test/",
      fetch,
    });

    await client.exchangePairingToken("pair-token", "heddle-test-client");
    await client.getShell();

    const exchange = fetch.mock.calls[0];
    expect(exchange?.[0]).toBe("http://t3.test/oauth/token");
    const body = exchange?.[1]?.body as InstanceType<
      typeof globalThis.URLSearchParams
    >;
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "pair-token",
      subject_token_type:
        "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "heddle-test-client",
    });
    expect(
      new globalThis.Headers(fetch.mock.calls[1]?.[1]?.headers).get(
        "authorization",
      ),
    ).toBe("Bearer access-token");
  });

  it("blocks a turn dispatch when its thread is absent", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ threads: [] }));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await expect(
      client.dispatch(
        {
          type: "thread.turn.start",
          commandId: "command-1",
          threadId: "missing-thread",
          runtimeMode: "auto-accept-edits",
        },
        {
          driver: "claudeAgent",
          cliVersion: "2.1.250",
          lifecycle: "independent",
        },
      ),
    ).rejects.toThrow(
      new T3PreconditionError(
        "Cannot dispatch 'thread.turn.start': thread 'missing-thread' does not exist",
      ),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("blocks a response when its request is absent", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          threads: [{ id: "thread-1", hasPendingApprovals: true }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ thread: { activities: [] } }));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await expect(
      client.respondToApproval("thread-1", "request-1", "accept", "command-1"),
    ).rejects.toThrow(
      "pending request 'request-1' does not exist on thread 'thread-1'",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("dispatches an approval response after its preconditions pass", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          threads: [{ id: "thread-1", hasPendingApprovals: true }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          thread: {
            activities: [
              {
                kind: "approval.requested",
                payload: { requestId: "request-1" },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ sequence: 42 }));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await expect(
      client.respondToApproval("thread-1", "request-1", "accept", "command-1"),
    ).resolves.toEqual({ sequence: 42 });
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toMatchObject({
      type: "thread.approval.respond",
      commandId: "command-1",
      threadId: "thread-1",
      requestId: "request-1",
      decision: "accept",
    });
  });

  it("translates the domain reject action to T3 decline", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          threads: [{ id: "thread-1", hasPendingApprovals: true }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          thread: {
            activities: [
              {
                kind: "approval.requested",
                payload: { requestId: "request-1" },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ sequence: 42 }));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await expect(
      client.respondToApproval("thread-1", "request-1", "reject", "command-1"),
    ).resolves.toEqual({ sequence: 42 });
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toMatchObject({
      type: "thread.approval.respond",
      commandId: "command-1",
      threadId: "thread-1",
      requestId: "request-1",
      decision: "decline",
    });
  });

  it("dispatches a user-input response after its preconditions pass", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          threads: [{ id: "thread-1", hasPendingUserInput: true }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          thread: {
            activities: [
              {
                kind: "user-input.requested",
                payload: { requestId: "request-1" },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ sequence: 43 }));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await expect(
      client.respondToUserInput(
        "thread-1",
        "request-1",
        { question_1: ["Choice A"] },
        "command-1",
      ),
    ).resolves.toEqual({ sequence: 43 });
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toMatchObject({
      type: "thread.user-input.respond",
      commandId: "command-1",
      threadId: "thread-1",
      requestId: "request-1",
      answers: { question_1: ["Choice A"] },
    });
  });

  it("surfaces an opaque dispatch failure with status and body", async () => {
    const opaque = {
      _tag: "EnvironmentInternalError",
      code: "internal_error",
      traceId: "trace-1",
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(opaque, 500));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await expect(
      client.dispatch({ type: "project.create", commandId: "command-1" }),
    ).rejects.toMatchObject<T3HttpError>({ status: 500, body: opaque });
  });
});
