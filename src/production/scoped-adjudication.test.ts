// ---
// relationships:
//   implements: heddle
// ---

import { describe, expect, it } from "vitest";

import type { SqlitePersistence } from "../persistence/index.js";
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

  const runtimeRow = (stageId: string) => ({
    binding: { modelSlug: "model-under-test" },
    instanceId,
    sessionKey,
    stageId,
    threadId,
  });

  /**
   * A control plane that accepts a response and only records the resolution
   * when its reactor runs, the way T3 does.
   */
  const syntheticT3 = (input: {
    activities: unknown[];
    onRespond?: (requestId: string) => unknown;
  }) => {
    const activities = [...input.activities];
    const approvals: string[] = [];
    const reactor: Array<() => void> = [];
    return {
      activities,
      approvals,
      runReactor: () => {
        for (const deliver of reactor.splice(0)) deliver();
      },
      t3: {
        getShell: async () => ({
          projects: [],
          threads: [{ hasPendingApprovals: true, id: threadId }],
        }),
        getThread: async () => ({ thread: { activities: [...activities] } }),
        respondToApproval: async (_threadId: string, requestId: string) => {
          approvals.push(requestId);
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
    onRespond?: (requestId: string) => unknown;
    stageId: string;
  }) => {
    const synthetic = syntheticT3(input);
    const persistence = {
      getInstance: () => ({ state: { handoffs: input.handoffs } }),
      listSessionRuntime: () => [runtimeRow(input.stageId)],
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
        now: () => now,
        persistence,
        t3: synthetic.t3,
      } as unknown as ConstructorParameters<
        typeof ProductionScopedAdjudication
      >[0]);
    return { ...synthetic, adjudication: construct(), construct };
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
      handoffs: [],
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

  it("abandons the adjudication with a visible cause when an answer never settles", async () => {
    // The reactor never delivers, so the request stays pending for good.
    const { adjudication, approvals } = build({
      activities: [sanctionedRequest("request-stuck", now - 90_000)],
      approvalSettlementMilliseconds: 60_000,
      handoffs: [adjudicationHandoff],
      stageId: "adjudication",
    });

    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      cause: "Adjudication tool approval did not settle within 60000ms",
      kind: "abandoned",
    });
    expect(approvals).toEqual([]);
  });

  it("keeps deferring only while the answer is inside the settlement bound", async () => {
    const { adjudication, approvals } = build({
      activities: [sanctionedRequest("request-slow", now - 30_000)],
      approvalSettlementMilliseconds: 60_000,
      handoffs: [adjudicationHandoff],
      stageId: "adjudication",
    });

    // Answering again is harmless, so a pass inside the bound defers again.
    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "deferred",
    });
    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toEqual({
      kind: "deferred",
    });
    expect(approvals).toEqual(["request-slow", "request-slow"]);
  });

  it("permits no unbounded deferral across restarts when nothing settles", async () => {
    // The bound is read from the request the control plane recorded, so
    // reconstructing the object cannot extend it.
    const { construct, approvals } = build({
      activities: [sanctionedRequest("request-stuck", now - 90_000)],
      approvalSettlementMilliseconds: 60_000,
      handoffs: [adjudicationHandoff],
      stageId: "adjudication",
    });

    const outcomes: string[] = [];
    for (let restart = 0; restart < 25; restart += 1) {
      outcomes.push(
        (await construct().settleSanctionedApprovals(sessionKey)).kind,
      );
    }

    expect(outcomes.every((kind) => kind === "abandoned")).toBe(true);
    expect(approvals).toEqual([]);
  });

  it("treats an unreadable request timestamp as outside the bound", async () => {
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

    expect(
      (await adjudication.settleSanctionedApprovals(sessionKey)).kind,
    ).toBe("abandoned");
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
