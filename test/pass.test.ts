// ---
// relationships:
//   verifies: node-types
// ---
import { expect, it, vi } from "vitest";
import { blueprint, passFixture } from "./support/pass-fixture.js";
import { makeSession } from "../src/t3code/test/support/thread-fixtures.js";
import { threadId, turnId } from "../src/t3code/index.js";

it("renders pinned inputs, activates after commit, and uses service-owned extra tool authorization", async () => {
  const plan = structuredClone(blueprint);
  const node = plan.nodes[0];
  if (!node) throw new Error("missing node");
  node.params = {
    ...node.params,
    prompt: "prompts/inspect.njk",
    handoff: "schemas/result.yml",
    tools: [
      { name: "catalog", endpoint: "https://tools.example.test/catalog" },
    ],
  };
  Object.assign(node, {
    metadata: { prompt: { inline: "Wrong prompt" }, runtimeMode: "auto" },
  });
  const read = vi.fn((_commit: string, _blueprint: string, path: string) =>
    Promise.resolve(
      path.endsWith("njk")
        ? "Inspect {{ item }}"
        : "type: object\ndescription: Submit result\nproperties: {}",
    ),
  );
  const authorization = vi.fn(() =>
    Promise.resolve("Bearer fixture-catalog-authorization"),
  );
  const f = passFixture(plan, {
    readArtifact: read,
    extraToolAuthorization: authorization,
  });
  await f.start();
  expect(read.mock.calls).toEqual([
    ["pinned", "inspection", "prompts/inspect.njk"],
    ["pinned", "inspection", "schemas/result.yml"],
  ]);
  expect(f.operations).toEqual([
    "register:heddle",
    "register:catalog",
    "thread.turn.start",
  ]);
  const generated = [...f.registrations.values()].find(
    (item) => item.name === "heddle",
  );
  const extra = [...f.registrations.values()].find(
    (item) => item.name === "catalog",
  );
  expect(extra?.authorizationHeader).toBe(
    "Bearer fixture-catalog-authorization",
  );
  expect(extra?.authorizationHeader).not.toBe(generated?.authorizationHeader);
  expect(authorization).toHaveBeenCalledWith({
    name: "catalog",
    endpoint: "https://tools.example.test/catalog",
  });
  const command = f.commands.find(
    (command) => command.type === "thread.turn.start",
  );
  expect(command).toMatchObject({
    message: { text: "Inspect parcel" },
    runtimeMode: "full-access",
  });
  expect(f.passes.read("run", "inspect")).toMatchObject({
    turnCount: 0,
    operatorTurnCount: 0,
  });
  expect(f.store.awaiting("run")).toHaveLength(1);
});

it("counts observed native and operator turns, refreshes inactivity, and keeps session replacement exact", async () => {
  const plan = structuredClone(blueprint);
  const node = plan.nodes[0];
  if (!node) throw new Error("missing node");
  node.params = { ...node.params, inactivity: "PT1M" };
  const f = passFixture(plan);
  await f.start();
  const initial = f.commands[0];
  if (initial?.type !== "thread.turn.start") throw new Error("missing start");
  f.emit(initial.threadId, "thread.turn-start-requested", {
    messageId: initial.message.messageId,
    modelSelection: initial.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: f.at,
  });
  f.emit(initial.threadId, "thread.session-set", {
    session: makeSession({
      threadId: initial.threadId,
      providerThreadId: "native-first",
      status: "running",
      activeTurnId: turnId("observed-first"),
    }),
  });
  await vi.waitFor(() => {
    expect(f.passes.sessions.resolve("native-first")?.threadId).toBe(
      initial.threadId,
    );
  });
  expect(f.passes.read("run", "inspect")).toMatchObject({
    turnCount: 1,
    operatorTurnCount: 0,
  });
  f.emit(initial.threadId, "thread.session-set", {
    session: makeSession({
      threadId: initial.threadId,
      providerThreadId: "native-first",
      status: "running",
      activeTurnId: turnId("observed-first"),
    }),
  });
  f.emit(initial.threadId, "thread.turn-start-requested", {
    messageId: "operator-message",
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: f.at,
  });
  f.emit(initial.threadId, "thread.session-set", {
    session: makeSession({
      threadId: initial.threadId,
      providerThreadId: "native-next",
      status: "running",
      activeTurnId: turnId("observed-operator"),
    }),
  });
  await vi.waitFor(() => {
    expect(f.passes.read("run", "inspect")).toMatchObject({
      turnCount: 2,
      operatorTurnCount: 1,
    });
  });
  expect(f.passes.sessions.resolve("native-first")).toBeUndefined();
  expect(f.passes.sessions.resolve("native-next")?.threadId).toBe(
    initial.threadId,
  );
  expect(
    f.store.events("run").filter((event) => event.type === "activity").length,
  ).toBeGreaterThan(0);
});

it("retires credentials and registration before rendering the next pass from the handoff", async () => {
  const plan = structuredClone(blueprint);
  plan.nodes.splice(1, 0, {
    id: "review",
    uses: "pass",
    params: {
      prompt: { inline: "Review {{ stages.inspect.handoff.accepted }}" },
      handoff: { type: "object", description: "Submit review" },
    },
  });
  plan.edges = [
    { source: "inspect", target: "review", condition: "result.output.handoff" },
    { source: "review", target: "finish", condition: "result.output.handoff" },
  ];
  const f = passFixture(plan);
  await f.start();
  const initial = f.commands[0];
  if (initial?.type !== "thread.turn.start") throw new Error("missing start");
  f.emit(initial.threadId, "thread.session-set", {
    session: makeSession({
      threadId: initial.threadId,
      providerThreadId: "native-first",
    }),
  });
  await vi.waitFor(() => {
    expect(f.passes.sessions.resolve("native-first")).toBeDefined();
  });
  await f.engine.resume({
    runId: "run",
    nodeId: "inspect",
    visit: 1,
    result: "handoff",
    payload: { accepted: true },
  });
  await vi.waitFor(() => {
    expect(f.commands).toHaveLength(2);
  });
  expect(f.passes.sessions.resolve("native-first")).toBeUndefined();
  expect(f.operations).toEqual([
    "register:heddle",
    "thread.turn.start",
    "clear:heddle",
    "register:heddle",
    "thread.turn.start",
  ]);
  expect(f.commands[1]).toMatchObject({ message: { text: "Review true" } });
});

it("recovers a committed active pass without sending its initial turn twice", async () => {
  const f = passFixture();
  await f.start();
  const first = f.commands[0];
  if (!first) throw new Error("missing start");
  f.emit(first.threadId as string, "thread.session-set", {
    session: makeSession({
      threadId: threadId(String(first.threadId)),
      providerThreadId: "native-first",
    }),
  });
  await vi.waitFor(() => {
    expect(f.passes.sessions.resolve("native-first")).toBeDefined();
  });
  await f.restart();
  await vi.waitFor(() => {
    expect(f.passes.sessions.resolve("native-first")).toBeDefined();
  });
  expect(f.commands).toHaveLength(1);
  expect(f.registrations.size).toBe(1);
});

it("waits for the prior turn to settle before replacing a reused provider session", async () => {
  const plan = structuredClone(blueprint);
  plan.nodes.splice(1, 0, {
    id: "review",
    uses: "pass",
    params: {
      resumeThread: "inspect",
      prompt: { inline: "Review result" },
      handoff: { type: "object", description: "Submit review" },
    },
  });
  plan.edges = [
    { source: "inspect", target: "review", condition: "result.output.handoff" },
    { source: "review", target: "finish", condition: "result.output.handoff" },
  ];
  const f = passFixture(plan);
  await f.start();
  const first = f.commands[0];
  if (first?.type !== "thread.turn.start") throw new Error("missing start");
  f.emit(first.threadId, "thread.session-set", {
    session: makeSession({
      threadId: first.threadId,
      status: "running",
      activeTurnId: turnId("prior-turn"),
      providerThreadId: "same-native",
    }),
  });
  await vi.waitFor(() => {
    expect(f.passes.sessions.resolve("same-native")).toBeDefined();
  });
  await f.engine.resume({
    runId: "run",
    nodeId: "inspect",
    visit: 1,
    result: "handoff",
    payload: { accepted: true },
  });
  expect(f.passes.sessions.resolve("same-native")).toBeUndefined();
  expect(f.commands).toHaveLength(1);
  expect(f.registrations.size).toBe(0);
  f.emit(first.threadId, "thread.session-set", {
    session: makeSession({
      threadId: first.threadId,
      status: "ready",
      activeTurnId: null,
      providerThreadId: "same-native",
    }),
  });
  await vi.waitFor(() => {
    expect(f.commands.at(-1)?.type).toBe("thread.session.stop");
  });
  expect(f.commands.at(-1)).not.toHaveProperty("onlyIfSettled");
  expect(f.registrations.size).toBe(0);
  f.emit(first.threadId, "thread.session-set", {
    session: makeSession({
      threadId: first.threadId,
      status: "stopped",
      providerThreadId: null,
    }),
  });
  await vi.waitFor(() => {
    expect(
      f.commands.filter((command) => command.type === "thread.turn.start"),
    ).toHaveLength(2);
  });
  const second = f.commands.at(-1);
  expect(second).toMatchObject({
    threadId: first.threadId,
    message: { text: "Review result" },
  });
  expect(f.passes.sessions.resolve("same-native")).toBeUndefined();
  f.emit(first.threadId, "thread.session-set", {
    session: makeSession({
      threadId: first.threadId,
      status: "running",
      activeTurnId: turnId("next-turn"),
      providerThreadId: "same-native",
    }),
  });
  await vi.waitFor(() => {
    expect(f.passes.sessions.resolve("same-native")?.nodeId).toBe("review");
  });
  expect(f.operations).toEqual([
    "register:heddle",
    "thread.turn.start",
    "clear:heddle",
    "thread.session.stop",
    "register:heddle",
    "thread.turn.start",
  ]);
});

it("retains a single initial command identity if dispatch committed before its acknowledgement was lost", async () => {
  const f = passFixture();
  await f.start();
  const row = f.store.db.prepare("SELECT data FROM pass_invocations").get();
  const saved = JSON.parse(String(row?.["data"])) as Record<string, unknown>;
  saved["dispatched"] = false;
  f.store.db
    .prepare("UPDATE pass_invocations SET data=?")
    .run(JSON.stringify(saved));
  await f.restart();
  await vi.waitFor(() => {
    expect(f.commands).toHaveLength(2);
  });
  expect(f.commands[1]?.commandId).toBe(f.commands[0]?.commandId);
  expect(f.committed.size).toBe(1);
});
