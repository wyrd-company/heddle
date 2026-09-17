// ---
// relationships:
//   verifies: node-types
// ---
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
  expect(Object.values(view?.usageByModel ?? {})).toEqual([
    { input: 120, cachedInput: 0, output: 30, reasoning: 0, total: 150 },
  ]);
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
