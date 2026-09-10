// ---
// relationships:
//   verifies: heddle
// ---
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestIdsFor } from "../control-plane/session-observation-attention.js";
import {
  EscalationCoordinator,
  WorkflowMcpSessionResolver,
} from "../mcp-server/index.js";
import { EscalationHistory } from "../mcp-server/escalation-history.js";
import { ProductionScopedAdjudication } from "./scoped-adjudication.js";
import { ProductionQuestionRouting } from "./question-routing.js";
import { ProductionEscalationAnswerEffects } from "./escalation-answer-effects.js";
import { isTodoState } from "../todo/index.js";
import { createProductionComposition } from "./composition.js";
import {
  execute,
  prepareProductionEpicFixture,
  SyntheticT3,
} from "./composition.test-support.js";

class QuestionT3 extends SyntheticT3 {
  readonly completed = new Set<string>();
  readonly failed = new Set<string>();
  override async getShell() {
    const shell = await super.getShell();
    return {
      ...shell,
      threads: shell.threads.map((thread) => ({
        ...thread,
        hasPendingUserInput:
          requestIdsFor(
            {
              thread: {
                activities: this.threadActivities.get(thread.id) ?? [],
              },
            },
            "user-input.requested",
          ).length > 0,
        ...(this.completed.has(thread.id)
          ? {
              latestTurn: {
                state: "completed",
                completedAt: "2026-01-01T00:00:00Z",
              },
              session: { status: "idle" },
            }
          : {}),
        ...(this.failed.has(thread.id)
          ? { latestTurn: { state: "error" }, session: { status: "error" } }
          : {}),
      })),
    };
  }
  ask(threadId: string, requestId: string) {
    const activities = this.threadActivities.get(threadId) ?? [];
    activities.push({
      kind: "user-input.requested",
      payload: {
        requestId,
        questions: [
          { id: "route", question: "Which route?", options: [] },
          {
            id: "ingredients",
            question: "Which ingredients?",
            multiSelect: true,
            options: [{ label: "Rice" }, { label: "Beans" }],
          },
          { id: "__proto__", question: "Enter a reference", options: [] },
        ],
      },
    });
    this.threadActivities.set(threadId, activities);
  }
}
const answers = {
  ["__proto__"]: {
    selectedOptions: [],
    text: "sample-reference",
    reasoning: "Matches the recipe.",
  },
  route: {
    selectedOptions: [],
    text: "The short route",
    reasoning: "The ingredients arrive sooner.",
  },
  ingredients: {
    selectedOptions: ["Rice"],
    text: "",
    reasoning: "The recipe needs rice.",
  },
};

describe("production harness question routing", { timeout: 30_000 }, () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  const setup = async (adjudication = false, endedMilliseconds = 60_000) => {
    const fixture = await prepareProductionEpicFixture();
    cleanups.push(fixture.cleanup);
    fixture.configuration.observationThresholds.endedMilliseconds =
      endedMilliseconds;
    if (adjudication)
      fixture.configuration.adjudication = {
        policyPath: "adjudication/policy.json",
        providerAlias: "primary",
      };
    const t3 = new QuestionT3();
    const page = vi.fn(async () => undefined);
    const composition = createProductionComposition({
      blueprintsRepositoryRoot: fixture.blueprintsRepositoryRoot,
      configuration: fixture.configuration,
      providerUsage: {
        readFiveHourWindow: async () => ({ used: 0, windowStartedAt: 0 }),
      },
      pushoverTransport: { send: page },
      t3,
      workflowMcpEndpoint: "http://127.0.0.1:4774/mcp",
    });
    cleanups.push(() => composition.close());
    await composition.start();
    const runtime = composition.persistence.listSessionRuntime()[0]!;
    const resolver = new WorkflowMcpSessionResolver(composition.persistence);
    const parent = await resolver.resolve(
      composition.persistence.getInstance(runtime.instanceId)!.state
        .correlationTokens[runtime.sessionKey]!,
    );
    return { fixture, t3, page, composition, runtime, resolver, parent };
  };
  it.each(["compatible", "disjoint"])(
    "preserves repeated native IDs and labels with %s option catalogs through MCP delivery and replay",
    async (catalog) => {
      const { t3, composition, runtime, parent } = await setup();
      const child = await composition.subagents.spawn(parent, {
        operationId: "prepare-references",
        providerAlias: "primary",
        rootItemId: "deliver",
      });
      if (child.kind !== "spawned") throw new Error("Child did not start");
      const questions = [
        {
          id: "reference",
          question: "Choose the initial reference",
          multiSelect: true,
          options: [
            { label: "First" },
            { label: "First" },
            { label: "Second" },
          ],
        },
        {
          id: "reference",
          question: "Choose the shared reference",
          multiSelect: false,
          options: [{ label: catalog === "compatible" ? "First" : "Third" }],
        },
      ];
      t3.threadActivities.set(child.assignment.threadId, [
        {
          kind: "user-input.requested",
          payload: { requestId: "repeated-native", questions },
        },
      ]);
      await composition.scheduler.trigger();
      const pending = composition.escalation.pendingEscalations(
        runtime.instanceId,
      )[0]!;
      expect(pending.questions).toEqual(questions);
      const callAnswer = async (entry: typeof answers.route) => {
        const response = await composition.mcp.fetch(
          new globalThis.Request("http://127.0.0.1:4774/mcp", {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${parent.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              id: "answer-repeated",
              jsonrpc: "2.0",
              method: "tools/call",
              params: {
                name: "answer",
                arguments: {
                  answers: { reference: entry },
                  escalationId: pending.escalationId,
                  ownerSessionKey: child.assignment.sessionKey,
                },
              },
            }),
          }),
        );
        expect(response.status).toBe(200);
        return response.json();
      };
      const invalid = await callAnswer({
        selectedOptions: ["Second"],
        text: "",
        reasoning: "The first catalog offers this value.",
      });
      expect(invalid.result.isError).toBe(true);
      expect(JSON.stringify(invalid)).toContain("offered option");
      expect(
        composition.escalation.pendingEscalations(runtime.instanceId),
      ).toHaveLength(1);
      expect(t3.userInputResponses).toEqual([]);
      expect(() =>
        composition.escalation.requireNoPendingForSession(
          runtime.instanceId,
          parent.sessionKey,
        ),
      ).toThrow(/pending/);
      const entry = {
        selectedOptions: catalog === "compatible" ? ["First"] : [],
        text: catalog === "compatible" ? "" : "A shared reference",
        reasoning: "This answer satisfies both occurrences.",
      };
      expect((await callAnswer(entry)).result.isError).not.toBe(true);
      const history = new EscalationHistory(composition.persistence);
      expect(history.answered(runtime.instanceId)[0]?.opened.questions).toEqual(
        questions,
      );
      expect(history.answered(runtime.instanceId)[0]?.answered.answers).toEqual(
        { reference: entry },
      );
      await composition.escalation.replayPendingDeliveries();
      expect(t3.userInputResponses).toEqual([
        {
          answers: {
            reference:
              catalog === "compatible" ? "First" : "A shared reference",
          },
          requestId: "repeated-native",
          threadId: child.assignment.threadId,
          commandId: expect.any(String),
        },
      ]);
      expect(history.pending(runtime.instanceId)).toEqual([]);
    },
  );
  it.each([0, 21])(
    "requires an explicit authorized answer for %s native questions and preserves delivery across replay",
    async (count) => {
      const { t3, composition, runtime, resolver, page } = await setup(true);
      const questions = Array.from({ length: count }, (_, index) => ({
        id: `reference-${index}`,
        question: "Enter a reference",
        options: [],
      }));
      const keyed = Object.fromEntries(
        questions.map(({ id }) => [
          id,
          {
            selectedOptions: [],
            text: "sample-reference",
            reasoning: "Matches the recipe.",
          },
        ]),
      );
      const native = Object.fromEntries(
        questions.map(({ id }) => [id, "sample-reference"]),
      );
      t3.threadActivities.set(runtime.threadId, [
        {
          kind: "user-input.requested",
          payload: { requestId: "native-count", questions },
        },
      ]);
      await composition.scheduler.trigger();
      await composition.escalation.replayPendingRoutes();
      const pending = composition.escalation.pendingEscalations(
        runtime.instanceId,
      )[0]!;
      expect(pending.questions).toHaveLength(count);
      expect(t3.userInputResponses).toEqual([]);
      expect(page).not.toHaveBeenCalled();
      expect(composition.attention.list()).toEqual([]);
      const adjudication = composition.persistence
        .listSessionRuntime()
        .find((item) => item.stageId === "adjudication")!;
      await expect(
        new ProductionScopedAdjudication({
          persistence: composition.persistence,
          t3,
        } as never).stop({
          reason: "answered",
          sessionKey: adjudication.sessionKey,
        }),
      ).rejects.toThrow(/answer is pending/);
      const binding = await resolver.resolve(
        composition.persistence.getInstance(runtime.instanceId)!.state
          .correlationTokens[adjudication.sessionKey]!,
      );
      const response = await composition.mcp.fetch(
        new globalThis.Request("http://127.0.0.1:4774/mcp", {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${binding.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            id: "answer-count",
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
              name: "answer",
              arguments: {
                answers: keyed,
                escalationId: pending.escalationId,
                ownerSessionKey: runtime.sessionKey,
              },
            },
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect((await response.json()).result.isError).not.toBe(true);
      const recovered = new EscalationCoordinator({
        persistence: composition.persistence,
        attention: { raise: vi.fn() },
        pushover: { send: vi.fn() },
        session: { steer: vi.fn() },
        delivery: new ProductionEscalationAnswerEffects(
          composition.persistence,
          composition.board,
          t3,
        ),
      });
      expect(recovered.pendingEscalations(runtime.instanceId)).toEqual([]);
      await recovered.replayPendingDeliveries();
      await recovered.replayPendingDeliveries();
      expect(t3.userInputResponses).toEqual([
        {
          answers: native,
          requestId: "native-count",
          threadId: runtime.threadId,
          commandId: expect.any(String),
        },
      ]);
      expect(
        new EscalationHistory(composition.persistence).answered(
          runtime.instanceId,
        )[0]?.answered.answers,
      ).toEqual(keyed);
    },
  );
  it("routes a zero-option harness request to adjudication and durably replies to its original request once", async () => {
    const { t3, composition, runtime, resolver, page, fixture } =
      await setup(true);
    t3.ask(runtime.threadId, "native-request");
    await composition.scheduler.trigger();
    await vi.waitFor(() =>
      expect(
        composition.persistence
          .listSessionRuntime()
          .filter((x) => x.stageId === "adjudication"),
      ).toHaveLength(1),
    );
    await composition.scheduler.trigger();
    expect(page).not.toHaveBeenCalled();
    expect(composition.attention.list()).toEqual([]);
    const pending = composition.escalation.pendingEscalations(
      runtime.instanceId,
    )[0]!;
    expect(pending).toMatchObject({
      requestId: "native-request",
      threadId: runtime.threadId,
      questions: [
        { id: "route", multiSelect: false, options: [] },
        { id: "ingredients", multiSelect: true },
        { id: "__proto__", multiSelect: false, options: [] },
      ],
    });
    const adjudication = composition.persistence
      .listSessionRuntime()
      .find((x) => x.stageId === "adjudication")!;
    const binding = await resolver.resolve(
      composition.persistence.getInstance(runtime.instanceId)!.state
        .correlationTokens[adjudication.sessionKey]!,
    );
    const stopAuthority = new ProductionScopedAdjudication({
      persistence: composition.persistence,
      t3,
    } as never);
    await expect(
      stopAuthority.stop({
        reason: "answered",
        sessionKey: adjudication.sessionKey,
      }),
    ).rejects.toThrow(/answer is pending/);
    const response = await composition.mcp.fetch(
      new globalThis.Request("http://127.0.0.1:4774/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${binding.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: "answer-one",
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "answer",
            arguments: {
              answers,
              escalationId: pending.escalationId,
              ownerSessionKey: runtime.sessionKey,
            },
          },
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).result.isError).not.toBe(true);
    await composition.escalation.replayPendingDeliveries();
    expect(t3.userInputResponses).toEqual([
      {
        answers: {
          route: "The short route",
          ingredients: ["Rice"],
          ["__proto__"]: "sample-reference",
        },
        requestId: "native-request",
        threadId: runtime.threadId,
        commandId: expect.any(String),
      },
    ]);
    expect(
      composition.persistence
        .replayEvents(runtime.instanceId)
        .find((x) => x.type === "mcp:escalation-answered")?.payload,
    ).toMatchObject({ answers, answeredBy: { kind: "adjudication" } });
    expect(
      new EscalationHistory(composition.persistence).answered(
        runtime.instanceId,
      )[0]?.answered.answers,
    ).toEqual(answers);
    const record = await execute("kanban-md", [
      "--dir",
      fixture.configuration.boardDirectory,
      "show",
      String(fixture.taskId),
      "--json",
    ]);
    expect(JSON.parse(record.stdout).body).toContain(
      "The ingredients arrive sooner.",
    );
  });
  it("routes child questions to their parent, re-pokes an idle answerer, and unblocks a chained question one link at a time", async () => {
    const { t3, composition, runtime, parent, page } = await setup();
    const child = await composition.subagents.spawn(parent, {
      operationId: "prepare-ingredients",
      providerAlias: "primary",
      rootItemId: "deliver",
    });
    if (child.kind !== "spawned") throw new Error("Child did not start");
    t3.ask(child.assignment.threadId, "child-request");
    await composition.scheduler.trigger();
    const pending = composition.escalation.pendingEscalations(
      runtime.instanceId,
    )[0]!;
    expect(pending.answeringAuthority).toEqual({
      kind: "session",
      sessionKey: parent.sessionKey,
    });
    expect(page).not.toHaveBeenCalled();
    const initial = t3.commands.filter(
      (x) => x.type === "thread.turn.start" && x.threadId === runtime.threadId,
    );
    expect(JSON.stringify(initial.at(-1))).toContain("Question ID: route");
    t3.completed.add(runtime.threadId);
    await composition.scheduler.trigger();
    const pokes = t3.commands.filter(
      (x) => x.type === "thread.turn.start" && x.threadId === runtime.threadId,
    );
    expect(pokes).toHaveLength(initial.length + 1);
    expect(JSON.stringify(pokes.at(-1))).toContain("Do not stop or advance");
    await composition.scheduler.trigger();
    expect(
      t3.commands.filter(
        (x) =>
          x.type === "thread.turn.start" && x.threadId === runtime.threadId,
      ),
    ).toHaveLength(pokes.length);
    expect(() =>
      composition.escalation.requireNoPendingForSession(
        runtime.instanceId,
        parent.sessionKey,
      ),
    ).toThrow(/pending escalation/);
    t3.ask(runtime.threadId, "parent-request");
    await composition.scheduler.trigger();
    await vi.waitFor(() =>
      expect(
        composition.attention.list().filter((x) => x.kind === "escalation"),
      ).toHaveLength(1),
    );
    const parentQuestion = composition.escalation
      .pendingEscalations(runtime.instanceId)
      .find((x) => x.ownerSessionKey === parent.sessionKey)!;
    const beforeOwnQuestionPoke = t3.commands.length;
    await new ProductionQuestionRouting(
      composition.persistence,
      composition.escalation,
      t3,
      composition.attention,
    ).poke(
      {
        instanceId: runtime.instanceId,
        sessionKey: parent.sessionKey,
        threadId: runtime.threadId,
      },
      {
        id: runtime.threadId,
        session: { status: "idle" },
        latestTurn: { state: "completed", completedAt: "2026-01-03T00:00:00Z" },
      },
    );
    expect(t3.commands).toHaveLength(beforeOwnQuestionPoke);
    await composition.escalation.answerAsOperator({
      answers,
      escalationId: parentQuestion.escalationId,
      instanceId: runtime.instanceId,
      ownerSessionKey: parent.sessionKey,
    });
    expect(
      composition.escalation.pendingEscalations(runtime.instanceId),
    ).toHaveLength(1);
    await composition.escalation.answerAsSession(parent, {
      answers,
      escalationId: pending.escalationId,
      ownerSessionKey: child.assignment.sessionKey,
    });
    expect(
      composition.escalation.pendingEscalations(runtime.instanceId),
    ).toEqual([]);
    expect(t3.userInputResponses.map((x) => [x.threadId, x.requestId])).toEqual(
      [
        [runtime.threadId, "parent-request"],
        [child.assignment.threadId, "child-request"],
      ],
    );
  });
  it("releases a withdrawn native question and never reopens it on repeated observation", async () => {
    const { t3, composition, runtime, parent } = await setup();
    t3.ask(runtime.threadId, "withdrawn-request");
    await composition.scheduler.trigger();
    await vi.waitFor(() =>
      expect(
        composition.attention.list().filter((x) => x.kind === "escalation"),
      ).toHaveLength(1),
    );
    const pending = composition.escalation.pendingEscalations(
      runtime.instanceId,
    )[0]!;
    t3.threadActivities.get(runtime.threadId)!.push({
      kind: "user-input.resolved",
      payload: {
        requestId: "withdrawn-request",
        answers: { route: "Answered elsewhere", ingredients: ["Beans"] },
      },
    });
    await composition.scheduler.trigger();
    await composition.scheduler.trigger();
    expect(
      composition.escalation.pendingEscalations(runtime.instanceId),
    ).toEqual([]);
    expect(
      composition.attention.list().filter((x) => x.kind === "escalation"),
    ).toEqual([]);
    expect(() =>
      composition.escalation.requireNoPendingForSession(
        runtime.instanceId,
        parent.sessionKey,
      ),
    ).not.toThrow();
    expect(
      composition.persistence
        .replayEvents(runtime.instanceId)
        .filter((x) => x.type === "mcp:escalation-withdrawn"),
    ).toHaveLength(1);
    const history = new EscalationHistory(composition.persistence);
    expect(() =>
      history.moveAuthority(
        pending,
        { kind: "session", sessionKey: parent.sessionKey },
        "Reassign resolved question",
      ),
    ).toThrow(/not pending/);
    await expect(
      composition.escalation.answerAsOperator({
        answers,
        escalationId: pending.escalationId,
        ownerSessionKey: pending.ownerSessionKey,
        instanceId: runtime.instanceId,
      }),
    ).rejects.toThrow();
  });
  it("pokes a completed unfinished stage once but never a running stage", async () => {
    const { t3, composition, runtime } = await setup(false, 1);
    const starts = () =>
      t3.commands.filter(
        (x) =>
          x.type === "thread.turn.start" && x.threadId === runtime.threadId,
      );
    const before = starts().length;
    await composition.scheduler.trigger();
    expect(starts()).toHaveLength(before);
    t3.completed.add(runtime.threadId);
    await composition.scheduler.trigger();
    expect(starts()).toHaveLength(before + 1);
    expect(JSON.stringify(starts().at(-1))).toContain(
      "Finish the work or use advance",
    );
    expect(composition.attention.list()).toEqual([]);
    await delay(2);
    await composition.scheduler.trigger();
    expect(starts()).toHaveLength(before + 1);
    expect(composition.attention.list()).toEqual([]);
    const recovered = new ProductionQuestionRouting(
      composition.persistence,
      composition.escalation,
      t3,
      composition.attention,
    );
    const target = {
      instanceId: runtime.instanceId,
      sessionKey: runtime.sessionKey,
      threadId: runtime.threadId,
    };
    await recovered.poke(
      target,
      (await t3.getShell()).threads.find((x) => x.id === runtime.threadId),
    );
    expect(starts()).toHaveLength(before + 1);
    for (const thread of [
      undefined,
      {
        id: runtime.threadId,
        session: { status: "running" },
        latestTurn: {
          state: "running",
          startedAt: "2026-01-02T00:00:00Z",
        },
      },
      { id: runtime.threadId, session: { status: "starting" } },
      { id: runtime.threadId, session: { status: "error" } },
      {
        id: runtime.threadId,
        session: { status: "idle" },
        hasPendingApprovals: true,
      },
      {
        id: runtime.threadId,
        session: { status: "idle" },
        hasPendingUserInput: true,
      },
      {
        id: runtime.threadId,
        session: { status: "idle" },
        backgroundLiveness: "working" as const,
      },
      {
        id: runtime.threadId,
        session: { status: "idle" },
        latestUserMessageAt: "2026-01-02T00:00:00Z",
        latestTurn: { state: "completed", completedAt: "2026-01-01T00:00:00Z" },
      },
    ]) {
      await recovered.poke(target, thread);
      expect(starts(), JSON.stringify(thread)).toHaveLength(before + 1);
    }
  });

  it.each(["session error", "observer error"])(
    "keeps native adjudication pending after an ordinary %s",
    async (failure) => {
      const { t3, composition, runtime } = await setup(true);
      t3.ask(runtime.threadId, "retained-request");
      await composition.scheduler.trigger();
      await composition.escalation.replayPendingRoutes();
      const adjudication = composition.persistence
        .listSessionRuntime()
        .find((item) => item.stageId === "adjudication")!;
      if (failure === "session error") {
        const getShell = t3.getShell.bind(t3);
        t3.getShell = async () => {
          const shell = await getShell();
          return {
            ...shell,
            threads: shell.threads.map((thread) =>
              thread.id === runtime.threadId
                ? { ...thread, session: { status: "error" } }
                : thread,
            ),
          };
        };
      } else {
        const getThread = t3.getThread.bind(t3);
        t3.getThread = async (threadId) => {
          if (threadId === runtime.threadId)
            throw new Error("Snapshot temporarily unavailable");
          return getThread(threadId);
        };
      }
      await composition.scheduler.trigger();
      await composition.escalation.replayPendingRoutes();
      expect(
        composition.escalation.pendingEscalations(runtime.instanceId),
      ).toHaveLength(1);
      expect(
        composition.persistence
          .replayEvents(runtime.instanceId)
          .filter(
            ({ type }) =>
              type === "mcp:escalation-withdrawn" ||
              type === "mcp:escalation-answered",
          ),
      ).toEqual([]);
      expect(t3.userInputResponses).toEqual([]);
      await expect(
        new ProductionScopedAdjudication({
          persistence: composition.persistence,
          t3,
        } as never).stop({
          reason: "failed",
          sessionKey: adjudication.sessionKey,
        }),
      ).rejects.toThrow(/answer is pending/);
      if (failure === "observer error")
        expect(JSON.stringify(composition.attention.list())).toContain(
          "session-observation-failed",
        );
      expect(
        t3.commands.filter(
          (command) =>
            command.type === "thread.session.stop" &&
            command.threadId === adjudication.threadId,
        ),
      ).toEqual([]);
    },
  );
  it.each(["withdrawn", "asker absent"])(
    "stops the scoped adjudicator after its native question is %s",
    async (cancellation) => {
      const { t3, composition, runtime } = await setup(true);
      t3.ask(runtime.threadId, "cancelled-request");
      await composition.scheduler.trigger();
      await composition.escalation.replayPendingRoutes();
      const adjudication = composition.persistence
        .listSessionRuntime()
        .find((item) => item.stageId === "adjudication")!;
      expect(adjudication).toBeDefined();
      if (cancellation === "asker absent") t3.threads.delete(runtime.threadId);
      else
        t3.threadActivities.get(runtime.threadId)!.push({
          kind: "user-input.resolved",
          payload: {
            requestId: "cancelled-request",
            answers: { route: "Another route", ingredients: ["Beans"] },
          },
        });
      await composition.scheduler.trigger();
      await composition.escalation.replayPendingRoutes();
      await composition.escalation.replayPendingRoutes();
      expect(
        composition.escalation.pendingEscalations(runtime.instanceId),
      ).toEqual([]);
      expect(
        t3.commands.filter(
          (command) =>
            command.type === "thread.session.stop" &&
            command.threadId === adjudication.threadId,
        ),
      ).toHaveLength(1);
      expect(t3.userInputResponses).toEqual([]);
      expect(
        composition.persistence
          .replayEvents(runtime.instanceId)
          .filter((event) => event.type === "mcp:escalation-answered"),
      ).toEqual([]);
    },
  );

  it.each([
    ["failed", "active"],
    ["absent", "active"],
    ["failed", "terminal"],
    ["absent", "terminal"],
  ] as const)(
    "returns a %s delegated answerer's owed question to the operator from a %s assignment",
    async (phase, assignmentState) => {
      const { t3, composition, runtime, parent, page } = await setup();
      const child = await composition.subagents.spawn(parent, {
        operationId: "read-reference",
        providerAlias: "primary",
        rootItemId: "deliver",
      });
      if (child.kind !== "spawned") throw new Error("Child did not start");
      const target = {
        instanceId: runtime.instanceId,
        sessionKey: child.assignment.sessionKey,
        threadId: child.assignment.threadId,
      };
      if (assignmentState === "terminal") {
        await composition.subagents.onObserved(target, {
          phase: "completed",
          attentions: [],
          archiveDispatched: false,
        });
      }
      t3.ask(runtime.threadId, "assigned-request");
      await composition.scheduler.trigger();
      const opened = composition.escalation.pendingEscalations(
        runtime.instanceId,
      )[0]!;
      await composition.escalation.moveAnswerAuthority({
        instanceId: runtime.instanceId,
        ownerSessionKey: parent.sessionKey,
        escalationId: opened.escalationId,
        reason: "The reference reader can answer",
        to: { kind: "session", sessionKey: target.sessionKey },
      });
      if (phase === "failed") t3.failed.add(target.threadId);
      else t3.threads.delete(target.threadId);
      const steers = t3.commands.filter(
        (command) =>
          command.type === "thread.turn.start" &&
          command.threadId === target.threadId,
      ).length;
      await composition.scheduler.trigger();
      await composition.scheduler.trigger();
      expect(
        composition.escalation.pendingEscalations(runtime.instanceId),
      ).toEqual([{ ...opened, answeringAuthority: { kind: "operator" } }]);
      expect(t3.userInputResponses).toEqual([]);
      expect(
        t3.commands.filter(
          (command) =>
            command.type === "thread.turn.start" &&
            command.threadId === target.threadId,
        ),
      ).toHaveLength(steers);
      const notices = composition.persistence
        .listAttention()
        .filter((entry) => entry.attentionId === opened.attentionId);
      expect(notices).toHaveLength(1);
      expect(page).toHaveBeenCalledTimes(1);
      await composition.escalation.answerAsOperator({
        instanceId: runtime.instanceId,
        ownerSessionKey: parent.sessionKey,
        escalationId: opened.escalationId,
        answers,
      });
      await composition.escalation.replayPendingDeliveries();
      expect(t3.userInputResponses).toHaveLength(1);
      expect(t3.userInputResponses[0]).toMatchObject({
        requestId: "assigned-request",
        threadId: runtime.threadId,
        answers: {
          route: "The short route",
          ingredients: ["Rice"],
          ["__proto__"]: "sample-reference",
        },
      });
      expect(
        composition.escalation.pendingEscalations(runtime.instanceId),
      ).toEqual([]);
    },
  );

  it("retains a delegated answerer after it stops while holding reassigned authority", async () => {
    const { t3, composition, runtime, parent } = await setup();
    const child = await composition.subagents.spawn(parent, {
      operationId: "read-recipe",
      providerAlias: "primary",
      rootItemId: "deliver",
    });
    if (child.kind !== "spawned") throw new Error("Child did not start");
    t3.ask(runtime.threadId, "assigned-request");
    await composition.scheduler.trigger();
    const pending = composition.escalation.pendingEscalations(
      runtime.instanceId,
    )[0]!;
    await composition.escalation.moveAnswerAuthority({
      instanceId: runtime.instanceId,
      ownerSessionKey: parent.sessionKey,
      escalationId: pending.escalationId,
      reason: "The recipe reader can answer",
      to: { kind: "session", sessionKey: child.assignment.sessionKey },
    });
    expect(() =>
      composition.escalation.requireNoPendingForSession(
        runtime.instanceId,
        child.assignment.sessionKey,
      ),
    ).toThrow(/pending escalation/);
    t3.completed.add(child.assignment.threadId);
    await composition.scheduler.trigger();
    const state = composition.persistence.getInstance(runtime.instanceId)!.state
      .todoState;
    if (!isTodoState(state)) throw new Error("Missing todo state");
    expect(
      state.lists
        .flatMap((x) => x.assignments ?? [])
        .find((x) => x.sessionKey === child.assignment.sessionKey)?.status,
    ).toBe("active");
    expect(
      t3.commands
        .filter(
          (x) =>
            x.threadId === child.assignment.threadId &&
            x.type === "thread.turn.start",
        )
        .some((x) => JSON.stringify(x).includes("Question ID: route")),
    ).toBe(true);
  });
});
