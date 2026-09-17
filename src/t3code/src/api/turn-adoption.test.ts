import { describe, expect, it } from "vitest";
import {
  at,
  events,
  ids,
  makeMessage,
  makeSession,
  makeThread,
  parseEvent,
} from "../../test/support/thread-fixtures.js";
import { messageId, turnId } from "../schemas/common.js";
import type { OrchestrationThread } from "../schemas/orchestration/read-model.js";
import { applyThreadEvent, turnOutcome } from "./thread-projection.js";
import { TurnAdoption } from "./turn-adoption.js";

const turnA = ids.turnId;
const turnB = turnId("turn-2");
const ours = messageId("m-ours");
const createdAt = "2020-01-01T00:00:10.000Z";
const later = "2020-01-01T00:00:20.000Z";

const runningTurn = (id: string, requestedAt: string) => ({
  turnId: id,
  state: "running",
  requestedAt,
  startedAt: requestedAt,
  completedAt: null,
  assistantMessageId: null,
});

/** Turn A was already running when our message was sent. */
function sentDuringA(): OrchestrationThread {
  return makeThread({
    messages: [
      makeMessage({ id: "m-a", role: "user", turnId: null, createdAt: at }),
      makeMessage({ id: ours, role: "user", turnId: null, createdAt }),
    ],
    session: makeSession({ status: "running", activeTurnId: turnA, updatedAt: at }),
    latestTurn: runningTurn(turnA, at),
  });
}

describe("TurnAdoption", () => {
  it("follows the turn running at dispatch: it takes our message when it settles", () => {
    const adoption = new TurnAdoption(ours, createdAt);
    let thread = sentDuringA();
    expect(adoption.seed(thread)).toBeUndefined();
    expect(adoption.turnId).toBe(turnA);
    const ready = parseEvent(events.sessionSet(21, { status: "ready", updatedAt: later }));
    adoption.onEvent(ready);
    thread = applyThreadEvent(thread, ready);
    expect(thread.latestTurn?.state).toBe("completed");
    expect(adoption.onSettled(turnOutcome(thread, thread.latestTurn as never))).toBe(true);
  });

  it("moves to a turn that starts while the followed one is still running", () => {
    const adoption = new TurnAdoption(ours, createdAt);
    adoption.seed(sentDuringA());
    adoption.onEvent(
      parseEvent(
        events.sessionSet(21, { status: "running", activeTurnId: turnB, updatedAt: later }),
      ),
    );
    expect(adoption.turnId).toBe(turnB);
    const thread = sentDuringA();
    expect(adoption.onSettled(turnOutcome(thread, { turnId: turnA, state: "completed" }))).toBe(
      false,
    );
    expect(adoption.onSettled(turnOutcome(thread, { turnId: turnB, state: "completed" }))).toBe(
      true,
    );
  });

  it("takes a session error only when no turn was running", () => {
    const fresh = new TurnAdoption(ours, createdAt);
    fresh.seed(
      makeThread({ messages: [makeMessage({ id: ours, role: "user", turnId: null, createdAt })] }),
    );
    fresh.onEvent(parseEvent(events.sessionSet(21, { status: "error", lastError: "boom" })));
    expect(fresh.onSettled(turnOutcome(makeThread(), { turnId: null, state: "error" }))).toBe(true);

    const during = new TurnAdoption(ours, createdAt);
    during.seed(sentDuringA());
    expect(during.onSettled(turnOutcome(makeThread(), { turnId: null, state: "error" }))).toBe(
      false,
    );
    expect(during.onSettled(turnOutcome(makeThread(), { turnId: turnA, state: "error" }))).toBe(
      true,
    );
  });

  it("settles from the seed when our turn already finished, and ignores an older settled turn", () => {
    const finished = makeThread({
      messages: [
        makeMessage({ id: ours, role: "user", turnId: null, createdAt }),
        makeMessage({ id: "b1", turnId: turnB, text: "beta", createdAt: later }),
      ],
      latestTurn: { ...runningTurn(turnB, later), state: "completed", completedAt: later },
    });
    const outcome = new TurnAdoption(ours, createdAt).seed(finished);
    expect(outcome).toMatchObject({ state: "completed", turnId: turnB });
    expect(outcome?.assistantMessage?.text).toBe("beta");

    // Started before us and completed before us: our start is still pending.
    const stale = makeThread({
      messages: [makeMessage({ id: ours, role: "user", turnId: null, createdAt })],
      latestTurn: { ...runningTurn(turnA, at), state: "completed", completedAt: at },
    });
    const adoption = new TurnAdoption(ours, createdAt);
    expect(adoption.seed(stale)).toBeUndefined();
    expect(adoption.turnId).toBeUndefined();

    // Started before us but completed after: it took our message.
    const overlapping = makeThread({
      messages: [makeMessage({ id: ours, role: "user", turnId: null, createdAt })],
      latestTurn: { ...runningTurn(turnA, at), state: "completed", completedAt: later },
    });
    expect(new TurnAdoption(ours, createdAt).seed(overlapping)).toMatchObject({ turnId: turnA });
  });

  it("keeps a link the server states for our own message over anything else", () => {
    const adoption = new TurnAdoption(ours, createdAt);
    adoption.seed(sentDuringA());
    adoption.onEvent(
      parseEvent(
        events.messageSent(21, { messageId: ours, role: "user", text: "hi", turnId: turnB }),
      ),
    );
    expect(adoption.turnId).toBe(turnB);
    adoption.onEvent(
      parseEvent(
        events.sessionSet(22, { status: "running", activeTurnId: turnA, updatedAt: later }),
      ),
    );
    expect(adoption.turnId).toBe(turnB);
  });
});
