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
      getThread: async () => ({ thread: { activities: input.activities } }),
      respondToApproval: async (
        _threadId: string,
        requestId: string,
        decision: string,
      ) => {
        approvals.push({ decision, requestId });
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
