// ---
// relationships:
//   verifies: t3-control-plane-client
//   references: t3-headless
// ---

import { describe, expect, it, vi } from "vitest";

import {
  T3ControlPlaneClient,
  T3HttpError,
  T3PreconditionError,
} from "./t3-control-plane-client.js";

const jsonResponse = (body: unknown, status = 200) =>
  new globalThis.Response(JSON.stringify(body), { status });

describe("T3ControlPlaneClient preconditions", () => {
  it.each([
    ["pairing token", "", "client-label", "Pairing token must not be empty"],
    ["client label", "pair-token", "", "Client label must not be empty"],
  ])(
    "rejects an empty %s",
    async (_name, pairingToken, clientLabel, message) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const client = new T3ControlPlaneClient({
        baseUrl: "http://t3.test",
        fetch,
      });

      await expect(
        client.exchangePairingToken(pairingToken, clientLabel),
      ).rejects.toThrow(new T3PreconditionError(message));
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects a token exchange response without an access token", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ token_type: "Bearer" }));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      fetch,
    });

    await expect(
      client.exchangePairingToken("pair-token", "client-label"),
    ).rejects.toMatchObject<T3HttpError>({
      status: 200,
      body: { token_type: "Bearer" },
    });
  });

  it.each([
    ["shell read", (client: T3ControlPlaneClient) => client.getShell()],
    [
      "dispatch",
      (client: T3ControlPlaneClient) =>
        client.dispatch({ type: "project.create", commandId: "command-1" }),
    ],
  ])("requires authentication before a %s", async (_name, operation) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      fetch,
    });

    await expect(operation(client)).rejects.toThrow(/no T3 access token/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an observation when the thread is absent", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ threads: [] }));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await expect(client.observeThread("missing-thread")).rejects.toThrow(
      "Thread 'missing-thread' is absent from the T3 shell snapshot",
    );
  });

  it("rejects a negative polling interval", async () => {
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
    });

    await expect(client.pollThread("thread-1", -1).next()).rejects.toThrow(
      "Polling interval must not be negative",
    );
  });

  it.each([
    "thread.turn.start",
    "thread.turn.interrupt",
    "thread.session.stop",
    "thread.approval.respond",
    "thread.user-input.respond",
  ])("requires a thread id for %s", async (commandType) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await expect(
      client.dispatch({ type: commandType, commandId: "command-1" }),
    ).rejects.toThrow(`Dispatch '${commandType}' requires threadId`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires a request id for a response command", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      jsonResponse({
        threads: [{ id: "thread-1", hasPendingApprovals: true }],
      }),
    );
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await expect(
      client.dispatch({
        type: "thread.approval.respond",
        commandId: "command-1",
        threadId: "thread-1",
      }),
    ).rejects.toThrow("Dispatch 'thread.approval.respond' requires requestId");
  });

  it("requires the shell to report the requested response kind as pending", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ threads: [{ id: "thread-1" }] }));
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await expect(
      client.respondToUserInput(
        "thread-1",
        "request-1",
        { question_1: "Choice A" },
        "command-1",
      ),
    ).rejects.toThrow("has no pending request of the required kind");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("requires the response id to match the latest request of its kind", async () => {
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
                payload: { requestId: "request-old" },
              },
              {
                kind: "approval.requested",
                payload: { requestId: "request-current" },
              },
            ],
          },
        }),
      );
    const client = new T3ControlPlaneClient({
      baseUrl: "http://t3.test",
      accessToken: "access-token",
      fetch,
    });

    await expect(
      client.respondToApproval(
        "thread-1",
        "request-old",
        "accept",
        "command-1",
      ),
    ).rejects.toThrow(
      "pending request 'request-old' does not exist on thread 'thread-1'",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
