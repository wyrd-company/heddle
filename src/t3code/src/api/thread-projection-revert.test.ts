import { describe, expect, it } from "vitest";
import {
  at,
  events,
  makeCheckpoint,
  makeMessage,
  makeThread,
  parseEvent,
} from "../../test/support/thread-fixtures.js";
import { applyThreadEvent } from "./thread-projection.js";

describe("applyThreadEvent: reverted", () => {
  it("drops checkpoints, messages, activities, and plans past the turn count", () => {
    const thread = makeThread({
      checkpoints: [
        makeCheckpoint({ turnId: "turn-1", checkpointTurnCount: 1, assistantMessageId: "a1" }),
        makeCheckpoint({ turnId: "turn-2", checkpointTurnCount: 2, assistantMessageId: "a2" }),
      ],
      messages: [
        makeMessage({
          id: "u1",
          role: "user",
          turnId: null,
          createdAt: "2020-01-01T00:00:01.000Z",
        }),
        makeMessage({ id: "a1", turnId: "turn-1" }),
        makeMessage({
          id: "u2",
          role: "user",
          turnId: null,
          createdAt: "2020-01-01T00:00:02.000Z",
        }),
        makeMessage({ id: "a2", turnId: "turn-2" }),
        makeMessage({ id: "import:old", role: "user", turnId: null }),
      ],
      activities: [
        {
          id: "act-1",
          tone: "info",
          kind: "approval.resolved",
          summary: "one",
          payload: {},
          turnId: "turn-1",
          createdAt: at,
        },
        {
          id: "act-2",
          tone: "info",
          kind: "approval.resolved",
          summary: "two",
          payload: {},
          turnId: "turn-2",
          createdAt: at,
        },
      ],
      proposedPlans: [
        { id: "plan-2", turnId: "turn-2", planMarkdown: "plan", createdAt: at, updatedAt: at },
      ],
      latestTurn: {
        turnId: "turn-2",
        state: "completed",
        requestedAt: at,
        startedAt: at,
        completedAt: at,
        assistantMessageId: "a2",
      },
    });
    const next = applyThreadEvent(thread, parseEvent(events.reverted(5, 1)));
    expect(next.checkpoints.map((c) => c.turnId)).toEqual(["turn-1"]);
    expect(next.messages.map((m) => m.id)).toEqual(["u1", "a1", "import:old"]);
    expect(next.activities.map((a) => a.id)).toEqual(["act-1"]);
    expect(next.proposedPlans).toEqual([]);
    expect(next.latestTurn).toMatchObject({
      turnId: "turn-1",
      state: "completed",
      assistantMessageId: "a1",
    });
    const empty = applyThreadEvent(next, parseEvent(events.reverted(6, 0)));
    expect(empty.checkpoints).toEqual([]);
    expect(empty.latestTurn).toBeNull();
    expect(empty.messages.map((m) => m.id)).toEqual(["import:old"]);
  });
});
