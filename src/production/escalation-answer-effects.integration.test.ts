// ---
// relationships:
//   verifies: heddle
// ---
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowMcpSessionResolver } from "../mcp-server/index.js";
import { createProductionComposition } from "./composition.js";
import { ProductionEscalationAnswerEffects } from "./escalation-answer-effects.js";
import {
  execute,
  prepareProductionEpicFixture,
  SyntheticT3,
} from "./composition.test-support.js";

describe("production native question answer delivery", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });
  const setup = async (
    answerKind: "text" | "single" | "multi" | "single-whitespace" = "text",
  ) => {
    const fixture = await prepareProductionEpicFixture();
    cleanup.push(fixture.cleanup);
    const t3 = new SyntheticT3();
    const composition = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: vi.fn(async () => undefined) },
      t3,
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
    });
    cleanup.push(() => composition.close());
    await composition.start();
    const runtime = composition.persistence.listSessionRuntime()[0]!;
    const binding = await new WorkflowMcpSessionResolver(
      composition.persistence,
    ).resolve(
      composition.persistence.getInstance(runtime.instanceId)!.state
        .correlationTokens[runtime.sessionKey]!,
    );
    await composition.escalation.escalate(binding, {
      escalationId: "route-request",
      requestId: "request-one",
      threadId: runtime.threadId,
      questions: [
        {
          id: "route",
          question: "Which route?",
          multiSelect: answerKind === "multi",
          options:
            answerKind === "text"
              ? []
              : [{ label: "Short" }, { label: "Long" }],
        },
      ],
    });
    const input = {
      answers: {
        route: {
          selectedOptions:
            answerKind === "text"
              ? []
              : answerKind !== "multi"
                ? ["Short"]
                : ["Short", "Long"],
          text:
            answerKind === "text"
              ? "The shorter route"
              : answerKind === "single-whitespace"
                ? " \t "
                : "",
          reasoning: "The ingredients arrive sooner.",
        },
      },
      escalationId: "route-request",
      instanceId: runtime.instanceId,
      ownerSessionKey: runtime.sessionKey,
    };
    return { fixture, t3, composition, runtime, input };
  };
  it.each(["text", "single", "multi", "single-whitespace"] as const)(
    "replies once to the original request and records the %s answer on task and epic",
    async (answerKind) => {
      const { fixture, t3, composition, runtime, input } =
        await setup(answerKind);
      const creates = t3.commands.filter(
        (x) => x.type === "thread.create",
      ).length;
      await composition.escalation.answerAsOperator(input);
      await composition.escalation.answerAsOperator(input);
      await composition.escalation.replayPendingDeliveries();
      expect(t3.userInputResponses).toEqual([
        {
          answers: {
            route:
              answerKind === "text"
                ? "The shorter route"
                : answerKind === "multi"
                  ? ["Short", "Long"]
                  : "Short",
          },
          threadId: runtime.threadId,
          requestId: "request-one",
          commandId: expect.any(String),
        },
      ]);
      expect(
        t3.commands.filter((x) => x.type === "thread.create"),
      ).toHaveLength(creates);
      const task = await composition.board.readTask(fixture.taskId);
      for (const id of [task.id, task.parent!]) {
        const result = await execute("kanban-md", [
          "--dir",
          fixture.configuration.boardDirectory,
          "show",
          String(id),
          "--json",
        ]);
        expect(JSON.parse(result.stdout).body).toContain(
          "Reasoning: The ingredients arrive sooner.",
        );
        expect(JSON.parse(result.stdout).body).toContain(
          `Answer: ${answerKind === "text" ? "The shorter route" : answerKind === "multi" ? "Short, Long" : "Short"}`,
        );
      }
      expect(() =>
        composition.escalation.requireNoPendingForSession(
          runtime.instanceId,
          runtime.sessionKey,
        ),
      ).not.toThrow();
    },
  );
  it.each(["text", "single", "multi"] as const)(
    "reconciles an accepted %s native reply after a crash before local completion",
    async (answerKind) => {
      const { t3, composition, runtime, input } = await setup(answerKind);
      const original = t3.respondToUserInput.bind(t3);
      let fail = true;
      t3.respondToUserInput = async (
        threadId,
        requestId,
        answers,
        commandId,
      ) => {
        const result = await original(threadId, requestId, answers, commandId);
        t3.threadActivities.set(threadId, [
          { kind: "user-input.resolved", payload: { requestId, answers } },
        ]);
        if (fail) {
          fail = false;
          throw new Error("Response receipt interrupted");
        }
        return result;
      };
      await expect(
        composition.escalation.answerAsOperator(input),
      ).rejects.toThrow("Response receipt interrupted");
      expect(
        composition.persistence
          .replayEvents(runtime.instanceId)
          .some((x) => x.type === "mcp:escalation-delivery-completed"),
      ).toBe(false);
      await composition.escalation.replayPendingDeliveries();
      expect(t3.userInputResponses).toHaveLength(1);
      expect(
        composition.persistence
          .replayEvents(runtime.instanceId)
          .filter((x) => x.type === "mcp:escalation-delivery-completed"),
      ).toHaveLength(1);
      expect(
        composition.persistence
          .replayEvents(runtime.instanceId)
          .filter((x) => x.type === "mcp:escalation-decision-recorded"),
      ).toHaveLength(1);
    },
  );
  it("refuses a reply when the native thread differs from the retained owner binding", async () => {
    const { t3, composition, runtime, input } = await setup();
    const opened = composition.escalation.pendingEscalations(
      runtime.instanceId,
    )[0]!;
    const replacementThreadId = "replacement-thread";
    t3.threads.add(replacementThreadId);
    expect(t3.threads).toEqual(
      new Set([runtime.threadId, replacementThreadId]),
    );
    const effects = new ProductionEscalationAnswerEffects(
      composition.persistence,
      composition.board,
      t3,
    );

    await expect(
      effects.deliver({
        answered: {
          answeredBy: { kind: "operator" },
          answers: input.answers,
          escalationId: input.escalationId,
          ownerSessionKey: input.ownerSessionKey,
        },
        commandId: "replacement-reply",
        opened: { ...opened, threadId: replacementThreadId },
      }),
    ).rejects.toThrow("Question reply cannot target a replacement thread");
    expect(t3.userInputResponses).toEqual([]);
  });
  it("contains unavailable-thread delivery without creating a replacement and recovers the original request", async () => {
    const { t3, composition, runtime, input } = await setup();
    const creates = t3.commands.filter(
      (x) => x.type === "thread.create",
    ).length;
    t3.threads.delete(runtime.threadId);
    await expect(
      composition.escalation.answerAsOperator(input),
    ).rejects.toThrow(/unavailable/);
    await composition.escalation.replayPendingDeliveries();
    expect(
      composition.attention
        .list()
        .some((x) =>
          x.attentionId.startsWith("production:escalation-settlement-failed:"),
        ),
    ).toBe(true);
    expect(t3.commands.filter((x) => x.type === "thread.create")).toHaveLength(
      creates,
    );
    t3.threads.add(runtime.threadId);
    await composition.escalation.replayPendingDeliveries();
    expect(t3.userInputResponses).toHaveLength(1);
    expect(
      composition.attention
        .list()
        .some((x) =>
          x.attentionId.startsWith("production:escalation-settlement-failed:"),
        ),
    ).toBe(false);
  });
});
