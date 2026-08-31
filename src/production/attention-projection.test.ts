// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it } from "vitest";

import type {
  DurableAttentionRecord,
  JsonValue,
  ReconcilerRuntimeRecord,
} from "../persistence/index.js";
import { projectProductionAttention } from "./attention-projection.js";

const runtime: ReconcilerRuntimeRecord = {
  boardStatus: "in-progress",
  instanceId: "task-41",
  state: "waiting",
  taskId: 41,
};

const record = (
  attentionId: string,
  payload: Record<string, JsonValue>,
): DurableAttentionRecord => ({
  attentionId,
  payload: { attentionId, ...payload },
  recordedAt: "2030-01-01T00:00:00.000Z",
});

describe("production attention projection", () => {
  it("projects an escalation through its durable production task", () => {
    const projected = projectProductionAttention(
      record("attention-escalation", {
        escalationId: "choice-one",
        instanceId: "task-41",
        openedAt: "2030-01-01T00:00:00.000Z",
        ownerSessionKey: "session-one",
        questions: [
          {
            id: "question-one",
            options: [
              {
                description: "Use the first path",
                id: "first",
                label: "First",
              },
              {
                description: "Use the second path",
                id: "second",
                label: "Second",
              },
            ],
            prompt: "Select a path",
          },
        ],
        stage: "implement",
      }),
      [runtime],
    );

    expect(projected).toMatchObject({
      actions: [
        {
          actionId: "escalation.answer",
          contract: {
            escalationId: "choice-one",
            instanceId: "task-41",
            kind: "escalation.answer",
            ownerSessionKey: "session-one",
          },
          input: {
            kind: "questions",
            questions: [
              {
                id: "question-one",
                multiSelect: false,
                options: [
                  { label: "First", value: "first" },
                  { label: "Second", value: "second" },
                ],
                prompt: "Select a path",
              },
            ],
          },
        },
      ],
      attentionId: "attention-escalation",
      instanceId: "task-41",
      kind: "escalation",
      scope: "task:41",
      taskId: 41,
    });
    expect(projected.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("projects approval and exact user-input catalogs through T3 actions", () => {
    const approval = projectProductionAttention(
      record("attention-approval", {
        instanceId: "task-41",
        kind: "approval",
        message: "Approval required",
        requestId: "approval-one",
        sessionKey: "session-one",
        threadId: "thread-one",
      }),
      [runtime],
    );
    expect(approval.actions.map(({ contract }) => contract)).toEqual([
      {
        decision: "accept",
        instanceId: "task-41",
        kind: "t3.approval.respond",
        requestId: "approval-one",
        sessionKey: "session-one",
        threadId: "thread-one",
      },
      {
        decision: "reject",
        instanceId: "task-41",
        kind: "t3.approval.respond",
        requestId: "approval-one",
        sessionKey: "session-one",
        threadId: "thread-one",
      },
    ]);

    const userInput = projectProductionAttention(
      record("attention-input", {
        instanceId: "task-41",
        kind: "user-input",
        message: "Input required",
        questions: [
          {
            header: "Direction",
            id: "question-one",
            multiSelect: true,
            options: [
              { description: "First route", label: "First" },
              { description: "Second route", label: "Second" },
            ],
            question: "Choose routes",
          },
        ],
        requestId: "input-one",
        sessionKey: "session-one",
        threadId: "thread-one",
      }),
      [runtime],
    );
    expect(userInput.actions[0]?.input).toEqual({
      kind: "questions",
      questions: [
        {
          header: "Direction",
          id: "question-one",
          multiSelect: true,
          options: [
            { description: "First route", label: "First", value: "First" },
            { description: "Second route", label: "Second", value: "Second" },
          ],
          prompt: "Choose routes",
        },
      ],
    });
  });

  it("keeps informational and pre-instance reconciler attention actionless", () => {
    expect(
      projectProductionAttention(
        record("attention-stalled", {
          instanceId: "task-41",
          kind: "stalled",
          message: "Session stalled",
          sessionKey: "session-one",
          threadId: "thread-one",
        }),
        [runtime],
      ),
    ).toMatchObject({ actions: [], scope: "task:41" });
    expect(
      projectProductionAttention(
        record("attention-lifecycle", {
          code: "lifecycle-not-declared",
          kind: "lifecycle-resolution",
          message: "Choose a lifecycle",
          taskId: 43,
        }),
        [],
      ),
    ).toMatchObject({ actions: [], scope: "task:43", taskId: 43 });
    expect(
      projectProductionAttention(
        record("attention-acceptance", {
          code: "uat-child-missing",
          kind: "epic-acceptance",
          message: "Epic requires a UAT child",
          taskId: 45,
        }),
        [],
      ),
    ).toMatchObject({ actions: [], scope: "epic:45", taskId: 45 });
  });

  it("fails closed on identity, task, and catalog disagreement", () => {
    expect(() =>
      projectProductionAttention(
        {
          ...record("attention-one", {
            code: "lifecycle-not-declared",
            kind: "lifecycle-resolution",
            message: "Choose a lifecycle",
            taskId: 41,
          }),
          payload: { attentionId: "attention-two" },
        },
        [runtime],
      ),
    ).toThrow("disagrees with its durable payload identity");
    expect(() =>
      projectProductionAttention(
        record("attention-input", {
          instanceId: "task-41",
          kind: "user-input",
          message: "Input required",
          questions: [],
          requestId: "input-one",
          sessionKey: "session-one",
          threadId: "thread-one",
        }),
        [runtime],
      ),
    ).toThrow("has no user-input questions");
    expect(() =>
      projectProductionAttention(
        record("attention-approval", {
          instanceId: "task-41",
          kind: "approval",
          message: "Approval required",
          requestId: "approval-one",
          sessionKey: "session-one",
          threadId: "thread-one",
        }),
        [],
      ),
    ).toThrow("does not resolve to one production task");
    expect(() =>
      projectProductionAttention(
        record("attention-escalation", {
          escalationId: "choice-one",
          instanceId: "task-41",
          ownerSessionKey: "session-one",
          questions: [
            {
              id: "question-one",
              options: [
                { description: "First", id: "same", label: "First" },
                { description: "Second", id: "same", label: "Second" },
              ],
              prompt: "Select a path",
            },
          ],
          stage: "implement",
        }),
        [runtime],
      ),
    ).toThrow("repeats option 'same'");
    expect(() =>
      projectProductionAttention(
        record("attention-input", {
          instanceId: "task-41",
          kind: "user-input",
          message: "Input required",
          questions: [
            {
              id: "question-one",
              multiSelect: false,
              options: [{ label: "Same" }, { label: "Same" }],
              question: "Choose a route",
            },
          ],
          requestId: "input-one",
          sessionKey: "session-one",
          threadId: "thread-one",
        }),
        [runtime],
      ),
    ).toThrow("repeats option 'Same'");
  });
});
