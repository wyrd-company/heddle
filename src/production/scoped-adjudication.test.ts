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

  const sanctionedRequest = (requestId: string) => ({
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

  const build = (input: {
    activities: unknown[];
    handoffs: unknown[];
    stageId: string;
  }) => {
    const approvals: Array<{ decision: string; requestId: string }> = [];
    const activities = [...input.activities];
    const persistence = {
      getInstance: () => ({ state: { handoffs: input.handoffs } }),
      listSessionRuntime: () => [
        {
          binding: { modelSlug: "model-under-test" },
          instanceId,
          sessionKey,
          stageId: input.stageId,
          threadId,
        },
      ],
    } as unknown as SqlitePersistence;
    const t3 = {
      getShell: async () => ({
        projects: [],
        threads: [{ hasPendingApprovals: true, id: threadId }],
      }),
      getThread: async () => ({ thread: { activities: [...activities] } }),
      respondToApproval: async (
        _threadId: string,
        requestId: string,
        decision: string,
      ) => {
        approvals.push({ decision, requestId });
        activities.push({ kind: "approval.resolved", payload: { requestId } });
        return { sequence: approvals.length };
      },
    } as unknown as ProductionT3Client;
    return {
      adjudication: new ProductionScopedAdjudication({
        persistence,
        t3,
      } as unknown as ConstructorParameters<
        typeof ProductionScopedAdjudication
      >[0]),
      approvals,
    };
  };

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
    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toBe(
      false,
    );
    expect(approvals).toEqual([]);
  });

  it("approves for a session carrying a stored adjudication handoff", async () => {
    const { adjudication, approvals } = build({
      activities: [sanctionedRequest("request-sanctioned")],
      handoffs: [adjudicationHandoff],
      stageId: "adjudication",
    });

    expect(adjudication.isAdjudicationSession(sessionKey)).toBe(true);
    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toBe(true);
    expect(approvals).toEqual([
      { decision: "accept", requestId: "request-sanctioned" },
    ]);
  });

  it("drains a stale request stacked under a live one without deferring forever", async () => {
    // The provider forgets a request across a restart, so it stays counted as
    // pending while a newer request arrives on top of it. Dispatching a
    // response to the stale request is what clears it.
    const approvals: string[] = [];
    const activities: unknown[] = [
      sanctionedRequest("request-stale"),
      sanctionedRequest("request-live"),
    ];
    const persistence = {
      getInstance: () => ({ state: { handoffs: [adjudicationHandoff] } }),
      listSessionRuntime: () => [
        {
          binding: { modelSlug: "model-under-test" },
          instanceId,
          sessionKey,
          stageId: "adjudication",
          threadId,
        },
      ],
    } as unknown as SqlitePersistence;
    const t3 = {
      getShell: async () => ({
        projects: [],
        threads: [{ hasPendingApprovals: activities.length > 0, id: threadId }],
      }),
      getThread: async () => ({ thread: { activities: [...activities] } }),
      respondToApproval: async (_threadId: string, requestId: string) => {
        approvals.push(requestId);
        activities.push(
          requestId === "request-stale"
            ? {
                kind: "provider.approval.respond.failed",
                payload: {
                  detail: "stale pending approval request",
                  requestId,
                },
              }
            : { kind: "approval.resolved", payload: { requestId } },
        );
        return { sequence: approvals.length };
      },
    } as unknown as ProductionT3Client;
    const adjudication = new ProductionScopedAdjudication({
      persistence,
      t3,
    } as unknown as ConstructorParameters<
      typeof ProductionScopedAdjudication
    >[0]);

    // One pass attempts both: the stale one is cleared, the live one answered.
    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toBe(true);
    expect(approvals).toEqual(["request-stale", "request-live"]);

    // Nothing is left pending, so the next pass defers observation no further.
    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toBe(
      false,
    );
    expect(approvals).toHaveLength(2);
  });

  it("cannot defer observation indefinitely however many passes run", async () => {
    // T3 replays an accepted receipt for a repeated command id, so an accepted
    // dispatch is not evidence that anything moved. Progress is counted per
    // request, so deferral is bounded by the number of distinct requests
    // however many receipts come back accepted.
    const requestIds = ["request-a", "request-b", "request-c"];
    const approvals: string[] = [];
    const persistence = {
      getInstance: () => ({ state: { handoffs: [adjudicationHandoff] } }),
      listSessionRuntime: () => [
        {
          binding: { modelSlug: "model-under-test" },
          instanceId,
          sessionKey,
          stageId: "adjudication",
          threadId,
        },
      ],
    } as unknown as SqlitePersistence;
    const t3 = {
      getShell: async () => ({
        projects: [],
        threads: [{ hasPendingApprovals: true, id: threadId }],
      }),
      // The pending set never changes, whatever is dispatched.
      getThread: async () => ({
        thread: { activities: requestIds.map(sanctionedRequest) },
      }),
      // T3 replays the accepted receipt for a repeated command id.
      respondToApproval: async (_threadId: string, requestId: string) => {
        approvals.push(requestId);
        return { sequence: approvals.length };
      },
    } as unknown as ProductionT3Client;
    const adjudication = new ProductionScopedAdjudication({
      persistence,
      t3,
    } as unknown as ConstructorParameters<
      typeof ProductionScopedAdjudication
    >[0]);

    const passes: boolean[] = [];
    for (let pass = 0; pass < 25; pass += 1) {
      passes.push(await adjudication.settleSanctionedApprovals(sessionKey));
    }

    // The pending set never moved, so no pass ever deferred observation.
    expect(passes.filter(Boolean)).toEqual([]);
  });

  it("permits no further deferral after a restart when nothing has changed", async () => {
    // Progress is read from the thread, not remembered, so reconstructing the
    // object cannot reopen the deferral a crash loop would otherwise repeat.
    const approvals: string[] = [];
    const persistence = {
      getInstance: () => ({ state: { handoffs: [adjudicationHandoff] } }),
      listSessionRuntime: () => [
        {
          binding: { modelSlug: "model-under-test" },
          instanceId,
          sessionKey,
          stageId: "adjudication",
          threadId,
        },
      ],
    } as unknown as SqlitePersistence;
    const t3 = {
      getShell: async () => ({
        projects: [],
        threads: [{ hasPendingApprovals: true, id: threadId }],
      }),
      getThread: async () => ({
        thread: { activities: [sanctionedRequest("request-stuck")] },
      }),
      respondToApproval: async (_threadId: string, requestId: string) => {
        approvals.push(requestId);
        return { sequence: approvals.length };
      },
    } as unknown as ProductionT3Client;

    const passes: boolean[] = [];
    for (let restart = 0; restart < 25; restart += 1) {
      const adjudication = new ProductionScopedAdjudication({
        persistence,
        t3,
      } as unknown as ConstructorParameters<
        typeof ProductionScopedAdjudication
      >[0]);
      passes.push(await adjudication.settleSanctionedApprovals(sessionKey));
    }

    expect(passes.filter(Boolean)).toEqual([]);
  });

  it("stops deferring observation for a request that never clears", async () => {
    const approvals: string[] = [];
    const persistence = {
      getInstance: () => ({ state: { handoffs: [adjudicationHandoff] } }),
      listSessionRuntime: () => [
        {
          binding: { modelSlug: "model-under-test" },
          instanceId,
          sessionKey,
          stageId: "adjudication",
          threadId,
        },
      ],
    } as unknown as SqlitePersistence;
    const t3 = {
      getShell: async () => ({
        projects: [],
        threads: [{ hasPendingApprovals: true, id: threadId }],
      }),
      // The request stays pending however often it is answered.
      getThread: async () => ({
        thread: { activities: [sanctionedRequest("request-stuck")] },
      }),
      respondToApproval: async (_threadId: string, requestId: string) => {
        approvals.push(requestId);
        return { sequence: approvals.length };
      },
    } as unknown as ProductionT3Client;
    const adjudication = new ProductionScopedAdjudication({
      persistence,
      t3,
    } as unknown as ConstructorParameters<
      typeof ProductionScopedAdjudication
    >[0]);

    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toBe(
      false,
    );
    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toBe(
      false,
    );
    expect(await adjudication.settleSanctionedApprovals(sessionKey)).toBe(
      false,
    );
  });

  it("keeps a shell read from escaping into the scheduler pass", async () => {
    const persistence = {
      getInstance: () => ({ state: { handoffs: [adjudicationHandoff] } }),
      listSessionRuntime: () => [
        {
          binding: { modelSlug: "model-under-test" },
          instanceId,
          sessionKey,
          stageId: "adjudication",
          threadId,
        },
      ],
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
    ).resolves.toBe(false);
  });
});
