import { describe, expect, it } from "vitest";
import {
  at,
  events,
  makeThread,
  parseEvent,
  userInputRequested,
} from "../../test/support/thread-fixtures.js";
import { applyThreadEvent, pendingRequests } from "./thread-projection.js";

describe("applyThreadEvent: activity-appended", () => {
  it("replaces an activity with the same id so a pending request can resolve in place", () => {
    let thread = makeThread();
    thread = applyThreadEvent(
      thread,
      parseEvent(events.activityAppended(1, { id: "activity-1", ...userInputRequested("r1") })),
    );
    expect(pendingRequests(thread).map((r) => r.requestId)).toEqual(["r1"]);
    thread = applyThreadEvent(
      thread,
      parseEvent(
        events.activityAppended(2, {
          id: "activity-1",
          kind: "user-input.resolved",
          payload: { requestId: "r1", answers: { q1: "yes" } },
        }),
      ),
    );
    expect(thread.activities).toHaveLength(1);
    expect(thread.activities[0]).toMatchObject({ id: "activity-1", kind: "user-input.resolved" });
    expect(pendingRequests(thread)).toEqual([]);
  });

  it("orders by sequence when present, else by createdAt then id", () => {
    let thread = makeThread();
    thread = applyThreadEvent(
      thread,
      parseEvent(events.activityAppended(1, { id: "b", createdAt: "2020-01-01T00:00:02.000Z" })),
    );
    thread = applyThreadEvent(
      thread,
      parseEvent(events.activityAppended(2, { id: "a", createdAt: "2020-01-01T00:00:01.000Z" })),
    );
    thread = applyThreadEvent(
      thread,
      parseEvent(events.activityAppended(3, { id: "c", sequence: 3, createdAt: at })),
    );
    expect(thread.activities.map((a) => a.id)).toEqual(["a", "b", "c"]);
  });
});
