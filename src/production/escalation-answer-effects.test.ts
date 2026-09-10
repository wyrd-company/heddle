// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AnsweredEscalation,
  PendingEscalation,
} from "../mcp-server/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import { ProductionEscalationAnswerEffects } from "./escalation-answer-effects.js";

describe("production escalation answer effects", () => {
  let root = "";

  afterEach(async () => {
    if (root !== "") await rm(root, { force: true, recursive: true });
  });

  it("records a delegated value answer with prose on both task and epic", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-escalation-effects-"));
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    persistence.writeReconcilerRuntime({
      boardStatus: "in-progress",
      instanceId: "sample-instance",
      state: "waiting",
      taskId: 24,
    });
    const appendTaskActivity = vi.fn(async () => true);
    const effects = new ProductionEscalationAnswerEffects(
      persistence,
      {
        appendTaskActivity,
        readTask: async () => ({
          blocked: false,
          dependencies: [],
          frontMatter: {},
          id: 24,
          parent: 12,
          priority: "medium",
          status: "in-progress",
          tags: [],
          title: "Arrange inventory",
        }),
      },
      {} as never,
    );
    const opened: PendingEscalation = {
      threadId: "thread-17",
      requestId: "request-one",
      answeringAuthority: {
        kind: "session",
        sessionKey: "review-session",
      },
      attentionId: `escalation:${"a".repeat(64)}`,
      escalationId: "sample-reference",
      instanceId: "sample-instance",
      openedAt: "2026-01-01T00:00:00.000Z",
      ownerSessionKey: "work-session",
      questions: [
        {
          options: [],
          multiSelect: false,
          id: "reference",
          question: "Which sample reference should be used?",
        },
      ],
      stage: "arrange",
    };
    const answered: AnsweredEscalation = {
      answeredBy: { kind: "session", sessionKey: "review-session" },
      answers: {
        reference: {
          selectedOptions: ["AB12"],
          text: "",
          reasoning: "The selected route fits the requested result.",
        },
      },
      escalationId: opened.escalationId,
      ownerSessionKey: opened.ownerSessionKey,
      prose: "Use this reference for the current sample.",
    };

    await effects.record({ answered, opened });

    expect(appendTaskActivity).toHaveBeenCalledTimes(2);
    expect(appendTaskActivity.mock.calls.map(([taskId]) => taskId)).toEqual([
      24, 12,
    ]);
    for (const [, , activity] of appendTaskActivity.mock.calls) {
      expect(activity).toContain(
        "Question: Which sample reference should be used?",
      );
      expect(activity).toContain("Answer: AB12");
      expect(activity).toContain(
        "Prose: Use this reference for the current sample.",
      );
      expect(activity).toContain("Answering authority: session:review-session");
    }
    persistence.close();
  });

  it("records a standalone task decision without requiring an epic parent", async () => {
    root = await mkdtemp(join(tmpdir(), "heddle-escalation-effects-"));
    const persistence = new SqlitePersistence({
      stateDirectory: join(root, "state"),
    });
    persistence.writeReconcilerRuntime({
      boardStatus: "in-progress",
      instanceId: "standalone-instance",
      state: "waiting",
      taskId: 31,
    });
    const appendTaskActivity = vi.fn(async () => true);
    const effects = new ProductionEscalationAnswerEffects(
      persistence,
      {
        appendTaskActivity,
        readTask: async () => ({
          blocked: false,
          dependencies: [],
          frontMatter: {},
          id: 31,
          priority: "medium",
          status: "in-progress",
          tags: [],
          title: "Inspect sample output",
        }),
      },
      {} as never,
    );
    const opened: PendingEscalation = {
      threadId: "thread-17",
      requestId: "request-one",
      answeringAuthority: { kind: "operator" },
      attentionId: `escalation:${"b".repeat(64)}`,
      escalationId: "standalone-choice",
      instanceId: "standalone-instance",
      openedAt: "2026-01-01T00:00:00.000Z",
      ownerSessionKey: "sample-session",
      questions: [
        {
          multiSelect: false,
          id: "route",
          options: [
            { description: "Use route A", label: "a" },
            { description: "Use route B", label: "b" },
          ],
          question: "Which route should be used?",
        },
      ],
      stage: "inspect",
    };

    await expect(
      effects.record({
        answered: {
          answeredBy: { kind: "operator" },
          answers: {
            route: {
              selectedOptions: ["a"],
              text: "",
              reasoning: "The selected route fits the requested result.",
            },
          },
          escalationId: opened.escalationId,
          ownerSessionKey: opened.ownerSessionKey,
        },
        opened,
      }),
    ).resolves.toBeUndefined();

    expect(appendTaskActivity).toHaveBeenCalledTimes(1);
    expect(appendTaskActivity).toHaveBeenCalledWith(
      31,
      expect.stringContaining(":task:31"),
      expect.stringContaining("Answer: a"),
    );
    persistence.close();
  });
});
