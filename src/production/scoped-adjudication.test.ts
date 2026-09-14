// ---
// relationships:
//   implements: heddle
// ---

import { describe, expect, it } from "vitest";

import type {
  JsonValue,
  PersistedEvent,
  SqlitePersistence,
} from "../persistence/index.js";
import type { ProductionT3Client } from "./composition.js";
import { ProductionScopedAdjudication } from "./scoped-adjudication.js";

describe("scoped adjudication sanctioned approvals", () => {
  const sessionKey = "session-under-test";
  const threadId = "thread-under-test";
  const instanceId = "instance-under-test";
  const now = 1_000_000;

  const sanctionedRequest = (requestId: string, createdAt = now) => ({
    createdAt: new Date(createdAt).toISOString(),
    kind: "approval.requested",
    payload: {
      appName: "external",
      detail: 'Allow the external MCP server to run tool "answer"?',
      requestId,
      requestKind: "mcp-elicitation",
    },
  });

  const adjudicationHandoff = {
    correlationToken: "token-under-test",
    escalationId: "escalation-under-test",
    handoff: "{}",
    kind: "adjudication-handoff",
    modelSlug: "model-under-test",
    ownerSessionKey: "owner-session",
    renderedHandoff: "rendered",
    sessionKey,
  };

  const runtimeRow = (kind: "adjudication" | "stage", stageId?: string) => ({
    binding: { modelSlug: "model-under-test" },
    instanceId,
    kind,
    sessionKey,
    ...(stageId === undefined ? {} : { stageId }),
    threadId,
  });

  /**
   * A control plane that accepts a response and only records the resolution
   * when its reactor runs, the way T3 does.
   */
  const syntheticT3 = (
    input: {
      activities: unknown[];
      hasPendingUserInput?: boolean;
      onRespond?: (requestId: string) => unknown;
    },
    responseStarting?: () => void,
  ) => {
    const activities = [...input.activities];
    const approvals: string[] = [];
    const approvalCommands: string[] = [];
    const reactor: Array<() => void> = [];
    return {
      activities,
      approvalCommands,
      approvals,
      runReactor: () => {
        for (const deliver of reactor.splice(0)) deliver();
      },
      t3: {
        getShell: async () => ({
          projects: [],
          threads: [
            {
              hasPendingApprovals: true,
              ...(input.hasPendingUserInput === true
                ? { hasPendingUserInput: true }
                : {}),
              id: threadId,
            },
          ],
        }),
        getThread: async () => ({ thread: { activities: [...activities] } }),
        respondToApproval: async (
          _threadId: string,
          requestId: string,
          _decision: "accept" | "reject",
          commandId?: string,
        ) => {
          responseStarting?.();
          approvals.push(requestId);
          approvalCommands.push(commandId ?? "");
          const recorded = input.onRespond?.(requestId);
          if (recorded !== undefined) {
            reactor.push(() => activities.push(recorded as never));
          }
          return { sequence: approvals.length };
        },
      } as unknown as ProductionT3Client,
    };
  };

  const build = (input: {
    activities: unknown[];
    approvalSettlementMilliseconds?: number;
    handoffs: unknown[];
    hasPendingUserInput?: boolean;
    onResponseAttempt?: (events: readonly PersistedEvent[]) => void;
    onRespond?: (requestId: string) => unknown;
    runtimeKind?: "adjudication" | "stage";
    stageId: string;
  }) => {
    let clock = now;
    const events: PersistedEvent[] = [];
    const synthetic = syntheticT3(input, () =>
      input.onResponseAttempt?.([...events]),
    );
    const persistence = {
      appendEvent: (
        eventInstanceId: string,
        type: string,
        payload: JsonValue,
      ) => {
        const event = {
          instanceId: eventInstanceId,
          payload,
          recordedAt: new Date(clock).toISOString(),
          sequence: events.length + 1,
          type,
        };
        events.push(event);
        return event;
      },
      getInstance: () => ({ state: { handoffs: input.handoffs } }),
      listSessionRuntime: () => [
        (input.runtimeKind ??
          (input.handoffs.includes(adjudicationHandoff)
            ? "adjudication"
            : "stage")) === "adjudication"
          ? runtimeRow("adjudication")
          : runtimeRow("stage", input.stageId),
      ],
      replayEvents: () => [...events],
    } as unknown as SqlitePersistence;
    const construct = () =>
      new ProductionScopedAdjudication({
        configuration: {
          adjudication: {
            ...(input.approvalSettlementMilliseconds === undefined
              ? {}
              : {
                  approvalSettlementMilliseconds:
                    input.approvalSettlementMilliseconds,
                }),
            policyPath: "adjudication/policy.json",
            providerAlias: "primary",
          },
        },
        now: () => clock,
        persistence,
        t3: synthetic.t3,
      } as unknown as ConstructorParameters<
        typeof ProductionScopedAdjudication
      >[0]);
    return {
      ...synthetic,
      adjudication: construct(),
      advance: (milliseconds: number) => {
        clock += milliseconds;
      },
      construct,
      events,
    };
  };

  const resolved = (requestId: string) => ({
    createdAt: new Date(now).toISOString(),
    kind: "approval.resolved",
    payload: { requestId },
  });

  it("refuses to approve for an ordinary session whose stage is named adjudication", async () => {
    // A blueprint author can name a lifecycle node "adjudication", and ordinary
    // session construction copies that node id straight into the stage id. Only
    // a stored adjudication handoff, which Heddle writes itself, is authority.
    const { adjudication, approvals } = build({
      activities: [sanctionedRequest("request-impersonated")],
      handoffs: [adjudicationHandoff],
      runtimeKind: "stage",
      stageId: "adjudication",
    });

    expect(adjudication.isAdjudicationSession(sessionKey)).toBe(false);
    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "none",
    });
    expect(approvals).toEqual([]);
  });

  it("defers the pass after answering rather than reading the result back at once", async () => {
    // The response is delivered by a separate reactor, so the request is still
    // pending when the dispatch returns. Reading it back here would see no
    // change and kill a healthy adjudication.
    const { adjudication, approvals, runReactor } = build({
      activities: [sanctionedRequest("request-sanctioned")],
      handoffs: [adjudicationHandoff],
      onRespond: resolved,
      stageId: "adjudication",
    });

    expect(adjudication.isAdjudicationSession(sessionKey)).toBe(true);
    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "deferred",
    });
    expect(approvals).toEqual(["request-sanctioned"]);

    // The reactor delivers, and a later pass sees nothing left to answer.
    runReactor();
    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "none",
    });
  });

  it("accepts settlement delivered later within the answer-time bound", async () => {
    const { adjudication, advance, construct, runReactor } = build({
      activities: [sanctionedRequest("request-delayed", now - 90_000)],
      approvalSettlementMilliseconds: 60_000,
      handoffs: [adjudicationHandoff],
      onRespond: resolved,
      stageId: "adjudication",
    });

    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "deferred",
    });
    advance(59_000);
    runReactor();
    expect(await construct().settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "none",
    });
  });

  it("drains a stale request stacked under a live one", async () => {
    // The provider forgot the older request across a restart, so it stays
    // counted as pending. Answering it is what clears it.
    const { adjudication, approvals, runReactor } = build({
      activities: [
        sanctionedRequest("request-stale"),
        sanctionedRequest("request-live"),
      ],
      handoffs: [adjudicationHandoff],
      onRespond: (requestId) =>
        requestId === "request-stale"
          ? {
              createdAt: new Date(now).toISOString(),
              kind: "provider.approval.respond.failed",
              payload: {
                detail: "stale pending approval request",
                requestId,
              },
            }
          : resolved(requestId),
      stageId: "adjudication",
    });

    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "deferred",
    });
    expect(approvals).toEqual(["request-stale", "request-live"]);

    runReactor();
    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "none",
    });
  });

  it("starts the settlement bound when first answering an old unanswered request", async () => {
    const { adjudication, approvals } = build({
      activities: [sanctionedRequest("request-stuck", now - 90_000)],
      approvalSettlementMilliseconds: 60_000,
      handoffs: [adjudicationHandoff],
      stageId: "adjudication",
    });

    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "deferred",
    });
    expect(approvals).toEqual(["request-stuck"]);
  });

  it("records response issuance before calling the control plane", async () => {
    let eventTypesAtResponse: string[] = [];
    const { adjudication } = build({
      activities: [sanctionedRequest("request-order")],
      handoffs: [adjudicationHandoff],
      onResponseAttempt: (events) => {
        eventTypesAtResponse = events.map(({ type }) => type);
      },
      stageId: "adjudication",
    });

    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "deferred",
    });
    expect(eventTypesAtResponse).toContain(
      "adjudication:approval-response-issued",
    );
  });

  it("expires only after the answer has remained unsettled beyond the bound", async () => {
    const { adjudication, advance, approvals } = build({
      activities: [sanctionedRequest("request-slow", now - 30_000)],
      approvalSettlementMilliseconds: 60_000,
      handoffs: [adjudicationHandoff],
      stageId: "adjudication",
    });

    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "deferred",
    });
    advance(60_001);
    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      cause: "Adjudication tool approval did not settle within 60000ms",
      kind: "abandoned",
    });
    expect(approvals).toEqual(["request-slow", "request-slow"]);
  });

  it("retains the answer-time settlement bound across repeated reconciliation and restart", async () => {
    const {
      adjudication,
      advance,
      approvalCommands,
      construct,
      events,
      approvals,
    } = build({
      activities: [sanctionedRequest("request-stuck", now - 90_000)],
      approvalSettlementMilliseconds: 60_000,
      handoffs: [adjudicationHandoff],
      stageId: "adjudication",
    });

    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "deferred",
    });
    advance(30_000);
    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "deferred",
    });
    advance(30_001);
    expect(await construct().settleSanctionedApprovals(sessionKey)).toEqual({
      cause: "Adjudication tool approval did not settle within 60000ms",
      kind: "abandoned",
    });
    expect(
      events.filter(
        ({ type }) => type === "adjudication:approval-response-issued",
      ),
    ).toHaveLength(1);
    expect(approvals).toHaveLength(3);
    expect(new Set(approvalCommands).size).toBe(1);
  });

  it("does not use an unreadable request timestamp as the settlement clock", async () => {
    const { adjudication } = build({
      activities: [
        {
          kind: "approval.requested",
          payload: {
            appName: "external",
            requestId: "request-undated",
            requestKind: "mcp-elicitation",
          },
        },
      ],
      handoffs: [adjudicationHandoff],
      stageId: "adjudication",
    });

    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "deferred",
    });
  });

  it("binds durable response issuance to each request occurrence across restart", async () => {
    const { activities, adjudication, construct, events, runReactor } = build({
      activities: [sanctionedRequest("request-first", now - 90_000)],
      approvalSettlementMilliseconds: 60_000,
      handoffs: [adjudicationHandoff],
      onRespond: resolved,
      stageId: "adjudication",
    });

    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "deferred",
    });
    runReactor();
    expect(await construct().settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "none",
    });

    activities.push(sanctionedRequest("request-second", now - 90_000));
    expect(await construct().settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "deferred",
    });
    expect(
      events
        .filter(({ type }) => type === "adjudication:approval-response-issued")
        .map(({ payload }) => (payload as { requestId: string }).requestId),
    ).toEqual(["request-first", "request-second"]);
  });

  it.each([
    ["session", "other-session", threadId],
    ["thread", sessionKey, "other-thread"],
  ])(
    "does not reuse a response issue from another %s namespace",
    async (_namespace, recordedSessionKey, recordedThreadId) => {
      const { adjudication, events } = build({
        activities: [sanctionedRequest("request-namespaced")],
        handoffs: [adjudicationHandoff],
        stageId: "adjudication",
      });
      events.push({
        instanceId,
        payload: {
          commandId: "other-command",
          instanceId,
          issuedAt: new Date(now).toISOString(),
          requestId: "request-namespaced",
          sessionKey: recordedSessionKey,
          threadId: recordedThreadId,
        },
        recordedAt: new Date(now).toISOString(),
        sequence: 1,
        type: "adjudication:approval-response-issued",
      });

      expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
        kind: "deferred",
      });
      expect(events).toHaveLength(2);
    },
  );

  it.each([
    ["empty command identity", "", new Date(now).toISOString()],
    ["unreadable issuance time", "recorded-command", "not-a-timestamp"],
  ])(
    "abandons a durable response issue with %s using its actual cause",
    async (_invalidField, commandId, issuedAt) => {
      const { adjudication, approvals, construct, events } = build({
        activities: [
          sanctionedRequest("request-valid-before-invalid"),
          sanctionedRequest("request-invalid-issue"),
        ],
        handoffs: [adjudicationHandoff],
        stageId: "adjudication",
      });
      events.push({
        instanceId,
        payload: {
          commandId,
          instanceId,
          issuedAt,
          requestId: "request-invalid-issue",
          sessionKey,
          threadId,
        },
        recordedAt: new Date(now).toISOString(),
        sequence: 1,
        type: "adjudication:approval-response-issued",
      });

      expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
        cause: "Adjudication approval response issuance evidence is invalid",
        kind: "abandoned",
      });
      expect(await construct().settleSanctionedApprovals(sessionKey)).toEqual({
        cause: "Adjudication approval response issuance evidence is invalid",
        kind: "abandoned",
      });
      expect(approvals).toEqual([]);
      expect(events).toHaveLength(1);
    },
  );

  it("permanently taints an adjudication thread with a sanctioned approval that has no usable identity", async () => {
    const { activities, adjudication, approvals, construct, events } = build({
      activities: [
        sanctionedRequest("request-valid"),
        sanctionedRequest("   "),
      ],
      handoffs: [adjudicationHandoff],
      stageId: "adjudication",
    });

    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      cause: "Adjudication tool approval request has no usable identity",
      kind: "abandoned",
    });

    activities.push(resolved("request-valid"));
    expect(await construct().settleSanctionedApprovals(sessionKey)).toEqual({
      cause: "Adjudication tool approval request has no usable identity",
      kind: "abandoned",
    });

    activities.push(sanctionedRequest("request-later"));
    expect(await construct().settleSanctionedApprovals(sessionKey)).toEqual({
      cause: "Adjudication tool approval request has no usable identity",
      kind: "abandoned",
    });
    expect(approvals).toEqual([]);
    expect(events).toEqual([]);
  });

  it("reuses the durable response command identity after restart", async () => {
    const { adjudication, approvalCommands, events } = build({
      activities: [sanctionedRequest("request-recorded-command")],
      handoffs: [adjudicationHandoff],
      stageId: "adjudication",
    });
    events.push({
      instanceId,
      payload: {
        commandId: "recorded-command",
        instanceId,
        issuedAt: new Date(now).toISOString(),
        requestId: "request-recorded-command",
        sessionKey,
        threadId,
      },
      recordedAt: new Date(now).toISOString(),
      sequence: 1,
      type: "adjudication:approval-response-issued",
    });

    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "deferred",
    });
    expect(approvalCommands).toEqual(["recorded-command"]);
  });

  it("approves its sanctioned tool while its own routed question is open", async () => {
    const { adjudication, approvals } = build({
      activities: [sanctionedRequest("request-sanctioned")],
      handoffs: [adjudicationHandoff],
      hasPendingUserInput: true,
      stageId: "adjudication",
    });

    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "deferred",
    });
    expect(approvals).toHaveLength(1);
  });

  it("refuses to stop for its own pending native question after settling the original answer", async () => {
    const dispatches: unknown[] = [];
    const openedAt = "2026-01-01T00:00:00.000Z";
    const question = {
      id: "sample",
      multiSelect: false,
      options: [{ label: "First" }],
      question: "Which sample should be used?",
    };
    const persistence = {
      listSessionRuntime: () => [runtimeRow("adjudication")],
      replayEvents: () => [
        {
          instanceId,
          payload: {
            answeringAuthority: { kind: "adjudication", sessionKey },
            attentionId: "attention-original",
            escalationId: "original-question",
            openedAt,
            ownerSessionKey: "owner-session",
            questions: [question],
            requestId: "request-original",
            threadId: "thread-owner",
            stage: "assess",
          },
          recordedAt: openedAt,
          sequence: 1,
          type: "mcp:escalation-opened",
        },
        {
          instanceId,
          payload: {
            answeredBy: { kind: "adjudication", sessionKey },
            answers: {
              sample: {
                selectedOptions: ["First"],
                text: "",
                reasoning: "The first sample fits.",
              },
            },
            escalationId: "original-question",
            ownerSessionKey: "owner-session",
          },
          recordedAt: openedAt,
          sequence: 2,
          type: "mcp:escalation-answered",
        },
        {
          instanceId,
          payload: {
            answeringAuthority: { kind: "operator" },
            attentionId: "attention-adjudicator",
            escalationId: "adjudicator-question",
            openedAt,
            ownerSessionKey: sessionKey,
            questions: [question],
            requestId: "request-adjudicator",
            threadId,
            stage: "adjudication",
          },
          recordedAt: openedAt,
          sequence: 3,
          type: "mcp:escalation-opened",
        },
      ],
    } as unknown as SqlitePersistence;
    const t3 = {
      dispatch: async (command: unknown) => {
        dispatches.push(command);
        return { sequence: dispatches.length };
      },
      getShell: async () => ({
        projects: [],
        threads: [
          {
            id: threadId,
            latestTurn: { state: "running" },
            session: { status: "running" },
          },
        ],
      }),
    } as unknown as ProductionT3Client;
    const adjudication = new ProductionScopedAdjudication({
      persistence,
      t3,
    } as unknown as ConstructorParameters<
      typeof ProductionScopedAdjudication
    >[0]);

    await expect(
      adjudication.stop({ reason: "answered", sessionKey }),
    ).rejects.toThrow("Adjudication cannot stop while its answer is pending");
    expect(dispatches).toEqual([]);
  });

  it("uses the default bound after issuing an answer", async () => {
    const { adjudication, advance, approvals } = build({
      activities: [sanctionedRequest("request-late", now - 120_000)],
      handoffs: [adjudicationHandoff],
      stageId: "adjudication",
    });

    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "deferred",
    });
    advance(60_001);
    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      cause: "Adjudication tool approval did not settle within 60000ms",
      kind: "abandoned",
    });
    expect(approvals).toEqual(["request-late", "request-late"]);
  });

  it("keeps a shell read from escaping into the scheduler pass", async () => {
    const persistence = {
      getInstance: () => ({ state: { handoffs: [adjudicationHandoff] } }),
      listSessionRuntime: () => [runtimeRow("adjudication")],
    } as unknown as SqlitePersistence;
    const t3 = {
      getShell: async () => {
        throw new Error("shell is unavailable");
      },
    } as unknown as ProductionT3Client;
    const adjudication = new ProductionScopedAdjudication({
      persistence,
      t3,
    } as unknown as ConstructorParameters<
      typeof ProductionScopedAdjudication
    >[0]);

    await expect(
      adjudication.settleSanctionedApprovals(sessionKey),
    ).resolves.toEqual({ kind: "none" });
  });
});
