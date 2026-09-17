import { describe, expect, it } from "vitest";
import {
  approvalRequested,
  approvalResolved,
  at,
  events,
  ids,
  makeSession,
  makeShellThread,
  makeThread,
  parseEvent,
  userInputRequested,
} from "../../test/support/thread-fixtures.js";
import {
  applyThreadEvent,
  pendingRequests,
  settledTurnStateForSessionStatus,
  threadPhase,
  turnOutcome,
} from "./thread-projection.js";

const runningTurn = {
  turnId: ids.turnId,
  state: "running",
  requestedAt: "2020-01-01T00:00:00.000Z",
  startedAt: "2020-01-01T00:00:00.000Z",
  completedAt: null,
  assistantMessageId: null,
};

describe("applyThreadEvent: message-sent", () => {
  it("appends a new message, appends streaming deltas, and replaces on final", () => {
    let thread = makeThread();
    thread = applyThreadEvent(
      thread,
      parseEvent(events.messageSent(1, { messageId: "m1", text: "po" })),
    );
    expect(thread.messages.map((m) => m.text)).toEqual(["po"]);
    thread = applyThreadEvent(
      thread,
      parseEvent(events.messageSent(2, { messageId: "m1", text: "ng" })),
    );
    expect(thread.messages[0]?.text).toBe("pong");
    expect(thread.messages[0]?.streaming).toBe(true);
    thread = applyThreadEvent(
      thread,
      parseEvent(events.messageSent(3, { messageId: "m1", text: "final", streaming: false })),
    );
    expect(thread.messages[0]?.text).toBe("final");
    expect(thread.messages[0]?.streaming).toBe(false);
    thread = applyThreadEvent(
      thread,
      parseEvent(events.messageSent(4, { messageId: "m1", text: "", streaming: false })),
    );
    expect(thread.messages[0]?.text).toBe("final");
  });

  it("ignores events for other threads and unknown events", () => {
    const thread = makeThread();
    const other = {
      ...events.messageSent(1, { messageId: "m1", text: "x" }),
      aggregateId: "thread-2",
    };
    expect(applyThreadEvent(thread, parseEvent(other))).toBe(thread);
    const unknown = parseEvent({ ...events.archived(2), type: "thread.something-new" });
    expect(applyThreadEvent(thread, unknown)).toBe(thread);
  });
});

describe("applyThreadEvent: session-set", () => {
  it("starts a running latest turn and settles it when the session leaves running", () => {
    let thread = makeThread();
    thread = applyThreadEvent(
      thread,
      parseEvent(events.sessionSet(1, { status: "running", activeTurnId: ids.turnId })),
    );
    expect(thread.latestTurn).toMatchObject({ turnId: ids.turnId, state: "running" });
    thread = applyThreadEvent(
      thread,
      parseEvent(events.sessionSet(2, { status: "ready", updatedAt: "2020-01-01T00:00:05.000Z" })),
    );
    expect(thread.latestTurn).toMatchObject({
      state: "completed",
      completedAt: "2020-01-01T00:00:05.000Z",
    });
  });

  it.each([
    ["idle", "completed"],
    ["ready", "completed"],
    ["error", "error"],
    ["interrupted", "interrupted"],
    ["stopped", "interrupted"],
    ["starting", null],
    ["running", null],
  ] as const)("settledTurnStateForSessionStatus(%s) = %s", (status, expected) => {
    expect(settledTurnStateForSessionStatus(status)).toBe(expected);
  });

  it("does not settle a turn that is not running", () => {
    const thread = makeThread({ latestTurn: { ...runningTurn, state: "completed" } });
    const next = applyThreadEvent(thread, parseEvent(events.sessionSet(1, { status: "error" })));
    expect(next.latestTurn?.state).toBe("completed");
    expect(next.session?.status).toBe("error");
  });
});

describe("applyThreadEvent: turn-diff-completed", () => {
  it("settles the turn when its session is not running it", () => {
    const thread = makeThread({
      latestTurn: runningTurn,
      session: makeSession({ status: "ready" }),
    });
    const next = applyThreadEvent(
      thread,
      parseEvent(events.turnDiffCompleted(1, { assistantMessageId: "m1" })),
    );
    expect(next.latestTurn).toMatchObject({
      turnId: ids.turnId,
      state: "completed",
      assistantMessageId: "m1",
    });
    expect(next.checkpoints).toHaveLength(1);
  });

  it("keeps the turn running while the session runs it, keeps interrupted, maps error", () => {
    const running = makeThread({
      latestTurn: runningTurn,
      session: makeSession({ status: "running", activeTurnId: ids.turnId }),
    });
    expect(
      applyThreadEvent(running, parseEvent(events.turnDiffCompleted(1, {}))).latestTurn?.state,
    ).toBe("running");
    const interrupted = makeThread({ latestTurn: { ...runningTurn, state: "interrupted" } });
    expect(
      applyThreadEvent(interrupted, parseEvent(events.turnDiffCompleted(2, {}))).latestTurn?.state,
    ).toBe("interrupted");
    const failed = applyThreadEvent(
      makeThread(),
      parseEvent(events.turnDiffCompleted(3, { status: "error" })),
    );
    expect(failed.latestTurn?.state).toBe("error");
  });

  it("does not let a placeholder overwrite a captured checkpoint", () => {
    const thread = applyThreadEvent(makeThread(), parseEvent(events.turnDiffCompleted(1, {})));
    const next = applyThreadEvent(
      thread,
      parseEvent(events.turnDiffCompleted(2, { status: "missing" })),
    );
    expect(next).toBe(thread);
  });
});

describe("applyThreadEvent: lifecycle events", () => {
  it("applies meta, archive, activity, and mode changes", () => {
    let thread = makeThread();
    thread = applyThreadEvent(thread, parseEvent(events.metaUpdated(1, { title: "Renamed" })));
    expect(thread.title).toBe("Renamed");
    thread = applyThreadEvent(thread, parseEvent(events.archived(2)));
    expect(thread.archivedAt).not.toBeNull();
    thread = applyThreadEvent(
      thread,
      parseEvent(events.activityAppended(3, approvalRequested("r1"))),
    );
    expect(thread.activities).toHaveLength(1);
    thread = applyThreadEvent(
      thread,
      parseEvent(events.activityAppended(3, approvalRequested("r1"))),
    );
    expect(thread.activities).toHaveLength(1);
  });
});

describe("pendingRequests", () => {
  it("derives open requests from activities in order", () => {
    let thread = makeThread();
    thread = applyThreadEvent(
      thread,
      parseEvent(events.activityAppended(1, approvalRequested("r1"))),
    );
    thread = applyThreadEvent(
      thread,
      parseEvent(events.activityAppended(2, userInputRequested("r2"))),
    );
    thread = applyThreadEvent(
      thread,
      parseEvent(events.activityAppended(3, approvalResolved("r1"))),
    );
    const pending = pendingRequests(thread);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "user-input", requestId: "r2" });
    expect(pending[0]?.kind === "user-input" && pending[0].payload.questions[0]?.id).toBe("q1");
  });
});

describe("turnOutcome", () => {
  it("picks the assistant message linked to the turn and the session error", () => {
    let thread = makeThread({ session: makeSession({ status: "error", lastError: "boom" }) });
    thread = applyThreadEvent(
      thread,
      parseEvent(events.messageSent(1, { messageId: "a1", text: "hi" })),
    );
    const outcome = turnOutcome(thread, { turnId: ids.turnId, state: "error" });
    expect(outcome.assistantMessage?.id).toBe("a1");
    expect(outcome.error).toBe("boom");
  });
});

describe("threadPhase", () => {
  it.each([
    [{ hasPendingApprovals: true }, "waiting_for_approval"],
    [{ hasPendingUserInput: true }, "waiting_for_input"],
    [{ session: makeSession({ status: "error" }) }, "failed"],
    [{ latestTurn: { ...runningTurn, state: "error" } }, "failed"],
    [{ session: makeSession({ status: "starting" }) }, "starting"],
    [{ session: makeSession({ status: "running", activeTurnId: ids.turnId }) }, "running"],
    [{ latestTurn: runningTurn }, "running"],
    [
      {
        latestTurn: { ...runningTurn, state: "completed", completedAt: "2020-01-01T00:00:01.000Z" },
      },
      "completed",
    ],
    [
      {
        latestTurn: {
          ...runningTurn,
          state: "interrupted",
          completedAt: "2020-01-01T00:00:01.000Z",
        },
      },
      "completed",
    ],
    [{ session: makeSession({ status: "ready" }) }, "completed"],
    [{}, "idle"],
    [{ session: makeSession({ status: "stopped" }) }, "idle"],
  ])("%j -> %s", (overrides, expected) => {
    expect(threadPhase(makeShellThread(overrides))).toBe(expected);
  });
});

describe("applyThreadEvent: metadata events", () => {
  it("applies snooze, pin, and pull-request link events", () => {
    let thread = makeThread();
    thread = applyThreadEvent(thread, parseEvent(events.snoozed(1, "2020-01-02T00:00:00.000Z")));
    expect(thread.snoozedUntil).toBe("2020-01-02T00:00:00.000Z");
    thread = applyThreadEvent(thread, parseEvent(events.unsnoozed(2)));
    expect(thread.snoozedUntil).toBeNull();
    thread = applyThreadEvent(thread, parseEvent(events.pinned(3, "k1")));
    expect(thread).toMatchObject({ pinnedAt: at, pinOrderKey: "k1" });
    thread = applyThreadEvent(thread, parseEvent(events.unpinned(4)));
    expect(thread).toMatchObject({ pinnedAt: null, pinOrderKey: null });

    thread = applyThreadEvent(thread, parseEvent(events.pullRequestLinked(5, 7)));
    thread = applyThreadEvent(thread, parseEvent(events.pullRequestLinked(6, 7)));
    expect(thread.pullRequests).toHaveLength(1);
    thread = applyThreadEvent(thread, parseEvent(events.pullRequestSynced(7, 7, "merged")));
    expect(thread.pullRequests[0]?.snapshot?.state).toBe("merged");
    thread = applyThreadEvent(thread, parseEvent(events.pullRequestUnlinked(8, 7)));
    expect(thread.pullRequests).toEqual([]);
    // A sync for a removed link is stale.
    expect(applyThreadEvent(thread, parseEvent(events.pullRequestSynced(9, 7, "open")))).toBe(
      thread,
    );
  });
});
