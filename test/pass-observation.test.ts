// ---
// relationships:
//   verifies: node-types
// ---
import { PassService } from "../src/pass/index.js";
import { turnId } from "../src/t3code/index.js";
import { expect, it, vi } from "vitest";
import { passFixture } from "./support/pass-fixture.js";
import { makeSession } from "../src/t3code/test/support/thread-fixtures.js";

it("attributes cumulative usage deltas and helper snapshots without counting replay twice", async () => {
  const f = passFixture();
  await f.start();
  const command = f.commands[0];
  if (command?.type !== "thread.turn.start") throw new Error("missing start");
  const id = command.threadId;
  f.emit(id, "thread.session-set", {
    session: makeSession({ threadId: id, providerThreadId: "native" }),
  });
  let index = 0;
  const activity = (kind: string, payload: Record<string, unknown>) => {
    f.emit(id, "thread.activity-appended", {
      activity: {
        id: `activity-${String(++index)}`,
        tone: "info",
        kind,
        summary: "fixture activity",
        payload,
        turnId: null,
        createdAt: f.at,
      },
    });
  };
  activity("context-window.updated", {
    usedTokens: 100,
    maxTokens: 1000,
    totalProcessedTokens: 100,
    inputTokens: 80,
    outputTokens: 20,
  });
  activity("context-window.updated", {
    usedTokens: 150,
    maxTokens: 1000,
    totalProcessedTokens: 150,
    inputTokens: 120,
    outputTokens: 30,
  });
  activity("task.started", {
    taskId: "helper",
    description: "Inspect package",
  });
  activity("task.progress", {
    taskId: "helper",
    usageSnapshot: true,
    typedUsage: { totalTokens: 20, inputTokens: 15 },
  });
  activity("task.progress", {
    taskId: "helper",
    usageSnapshot: true,
    typedUsage: { totalTokens: 20, inputTokens: 15 },
  });
  activity("task.progress", {
    taskId: "helper",
    usageSnapshot: true,
    typedUsage: { totalTokens: 25 },
  });
  activity("context-compaction", {
    state: "compacted",
    beforeTokens: 150,
    afterTokens: 50,
  });
  activity("approval.requested", {
    requestId: "approval",
    requestKind: "command",
    detail: "Inspect package",
  });
  await vi.waitFor(() => {
    expect(f.passes.read("run", "inspect")?.openRequests).toHaveLength(1);
  });
  const view = f.passes.read("run", "inspect");
  expect(Object.values(view?.usageByModel ?? {})).toEqual([{ total: 150 }]);
  expect(view?.helpers["helper"]?.["typedUsage"]).toEqual({
    totalTokens: 25,
    inputTokens: 15,
  });
  expect(view).toMatchObject({
    contextRatio: 0.15,
    previousContextRatio: 0.1,
    compactions: [{ state: "compacted", beforeTokens: 150, afterTokens: 50 }],
  });
  await f.restart();
  expect(f.passes.read("run", "inspect")).toEqual(view);
  activity("approval.resolved", { requestId: "approval", decision: "accept" });
  await vi.waitFor(() => {
    expect(f.passes.read("run", "inspect")?.openRequests).toEqual([]);
  });
});

it("reconciles failed runs and keeps late registration acknowledgements retired", async () => {
  const f = passFixture();
  let release: () => void = () => {
    throw new Error("not started");
  };
  const registered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.client.mcp.ensureRegistration;
  vi.mocked(original).mockImplementationOnce(async (input) => {
    await registered;
    f.registrations.set(`${input.threadId}:${input.name ?? "default"}`, input);
  });
  await f.engine.start({
    id: "run",
    blueprintId: "inspection",
    commit: "pinned",
    context: { item: "parcel" },
  });
  await vi.waitFor(() => {
    expect(original).toHaveBeenCalledTimes(1);
  });
  f.store.status("run", "failed");
  const cleanup = f.passes.synchronize(f.store.get("run"));
  release();
  await cleanup;
  expect(f.commands).toEqual([]);
  expect(f.registrations.size).toBe(0);
  const row = f.store.db.prepare("SELECT data FROM pass_invocations").get();
  expect(JSON.parse(String(row?.["data"])) as unknown).toMatchObject({
    phase: "retired",
    binding: null,
    registrationNames: [],
  });
  expect(f.store.db.prepare("SELECT * FROM hook_sessions").all()).toEqual([]);
});

it("delivers a turn settlement replayed before synchronization after restart", async () => {
  const f = passFixture();
  await f.start();
  const command = f.commands[0];
  if (command?.type !== "thread.turn.start") throw new Error("missing start");
  f.emit(command.threadId, "thread.turn-start-requested", {
    messageId: command.message.messageId,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: f.at,
  });
  f.emit(command.threadId, "thread.session-set", {
    session: makeSession({
      threadId: command.threadId,
      status: "running",
      activeTurnId: turnId("observed-turn"),
      providerThreadId: "native",
    }),
  });
  await vi.waitFor(() => {
    expect(f.passes.read("run", "inspect")?.turnCount).toBe(1);
  });
  f.passes.close();
  f.emit(command.threadId, "thread.session-set", {
    session: makeSession({
      threadId: command.threadId,
      status: "ready",
      activeTurnId: null,
      providerThreadId: "native",
    }),
  });
  await f.restart();
  await vi.waitFor(() => {
    expect(f.store.get("run").status).toBe("completed");
  });
  const resumes = f.store
    .events("run")
    .filter((event) => event.type === "resume");
  expect(resumes).toHaveLength(1);
  expect(resumes[0]?.payload).toMatchObject({
    result: "turnEnded",
    payload: {
      policy: "require-handoff",
      reminder: "Call the handoff tool for this stage before ending the turn.",
    },
  });
});

it("keeps a prepared invocation and its credential when recovering before the awaiting commit", async () => {
  const f = passFixture();
  const ensure = f.client.threads.ensure;
  vi.mocked(ensure).mockImplementationOnce(
    () =>
      new Promise(() => {
        /* Simulate loss while T3 ensure is in flight. */
      }),
  );
  void f.engine.start({
    id: "run",
    blueprintId: "inspection",
    commit: "pinned",
    context: { item: "parcel" },
  });
  await vi.waitFor(() => {
    expect(ensure).toHaveBeenCalledTimes(1);
  });
  const before = String(
    f.store.db.prepare("SELECT data FROM pass_invocations").get()?.["data"],
  );
  f.passes.close();
  f.store.active.clear();
  // recover() must not retire the unfinished visit before the engine can replay it.
  const recovered = new PassService(f.engine, f.options);
  await recovered.recover();
  expect(
    String(
      f.store.db.prepare("SELECT data FROM pass_invocations").get()?.["data"],
    ),
  ).toBe(before);
  recovered.close();
});

it("keeps final usage with the retired pass and starts reused-pass totals at the prior baseline", async () => {
  const plan = structuredClone(
    (await import("./support/pass-fixture.js")).blueprint,
  );
  const first = plan.nodes[0];
  if (!first) throw new Error("missing node");
  plan.nodes.splice(1, 0, {
    id: "review",
    uses: "pass",
    params: { ...first.params, resumeThread: "inspect" },
  });
  plan.edges = [
    { source: "inspect", target: "review", condition: "result.output.handoff" },
    { source: "review", target: "finish", condition: "result.output.handoff" },
  ];
  const f = passFixture(plan);
  await f.start();
  const command = f.commands[0];
  if (command?.type !== "thread.turn.start") throw new Error("missing start");
  const id = command.threadId;
  f.emit(id, "thread.session-set", {
    session: makeSession({
      threadId: id,
      status: "running",
      activeTurnId: turnId("first-turn"),
      providerThreadId: "native",
    }),
  });
  await vi.waitFor(() => {
    expect(f.passes.read("run", "inspect")?.turnCount).toBe(1);
  });
  await f.engine.resume({
    runId: "run",
    nodeId: "inspect",
    visit: 1,
    result: "handoff",
    payload: { accepted: true },
  });
  f.emit(id, "thread.activity-appended", {
    activity: {
      id: "late-usage",
      tone: "info",
      kind: "context-window.updated",
      summary: "Usage",
      payload: { usedTokens: 100, totalProcessedTokens: 100 },
      turnId: "first-turn",
      createdAt: f.at,
    },
  });
  await vi.waitFor(() => {
    expect(
      Object.values(f.passes.read("run", "inspect")?.usageByModel ?? {}),
    ).toEqual([{ total: 100 }]);
  });
  expect(f.passes.read("run", "review")?.usageByModel).toEqual({});
  f.emit(id, "thread.session-set", {
    session: makeSession({
      threadId: id,
      status: "ready",
      providerThreadId: "native",
    }),
  });
  await vi.waitFor(() => {
    expect(f.commands.at(-1)?.type).toBe("thread.session.stop");
  });
  f.emit(id, "thread.session-set", {
    session: makeSession({
      threadId: id,
      status: "stopped",
      providerThreadId: null,
    }),
  });
  await vi.waitFor(() => {
    expect(
      f.commands.filter((command) => command.type === "thread.turn.start"),
    ).toHaveLength(2);
  });
  f.emit(id, "thread.session-set", {
    session: makeSession({
      threadId: id,
      status: "running",
      activeTurnId: turnId("next-turn"),
      providerThreadId: "native",
    }),
  });
  f.emit(id, "thread.activity-appended", {
    activity: {
      id: "next-usage",
      tone: "info",
      kind: "context-window.updated",
      summary: "Usage",
      payload: { usedTokens: 125, totalProcessedTokens: 225 },
      turnId: "next-turn",
      createdAt: f.at,
    },
  });
  await vi.waitFor(() => {
    expect(
      Object.values(f.passes.read("run", "review")?.usageByModel ?? {}),
    ).toEqual([{ total: 125 }]);
  });
  expect(
    Object.values(f.passes.read("run", "inspect")?.usageByModel ?? {}),
  ).toEqual([{ total: 100 }]);
  expect(f.passes.read("run", "review")).toMatchObject({
    turnCount: 1,
    operatorTurnCount: 0,
  });
});

it("preserves newer observations while remote retirement acknowledgement is pending", async () => {
  const f = passFixture();
  await f.start();
  const command = f.commands[0];
  if (command?.type !== "thread.turn.start") throw new Error("missing start");
  const id = command.threadId;
  f.emit(id, "thread.session-set", {
    session: makeSession({
      threadId: id,
      status: "running",
      activeTurnId: turnId("tail-turn"),
      providerThreadId: "native",
    }),
  });
  await vi.waitFor(() => {
    expect(f.passes.read("run", "inspect")?.turnCount).toBe(1);
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(f.client.mcp.clear).mockImplementationOnce(async () => {
    await held;
  });
  const resumed = f.engine.resume({
    runId: "run",
    nodeId: "inspect",
    visit: 1,
    result: "handoff",
    payload: { accepted: true },
  });
  await vi.waitFor(() => {
    expect(f.client.mcp.clear).toHaveBeenCalled();
  });
  f.emit(id, "thread.activity-appended", {
    activity: {
      id: "tail-usage",
      tone: "info",
      kind: "context-window.updated",
      summary: "Usage",
      payload: { usedTokens: 75, totalProcessedTokens: 75 },
      turnId: "tail-turn",
      createdAt: f.at,
    },
  });
  await vi.waitFor(() => {
    expect(
      Object.values(f.passes.read("run", "inspect")?.usageByModel ?? {}),
    ).toEqual([{ total: 75 }]);
  });
  release();
  await resumed;
  expect(
    Object.values(f.passes.read("run", "inspect")?.usageByModel ?? {}),
  ).toEqual([{ total: 75 }]);
});
