// ---
// relationships:
//   verifies: node-types
// ---
import { threadId } from "../src/t3code/index.js";
import { expect, it, vi } from "vitest";
import { PassStore } from "../src/pass/store.js";
import { retirePass } from "../src/pass/lifecycle.js";
import { passFixture } from "./support/pass-fixture.js";
import { makeSession } from "../src/t3code/test/support/thread-fixtures.js";

it("retires an orphaned registration and its raw credential through the lifecycle adapter", async () => {
  const f = passFixture();
  await f.start();
  const store = new PassStore(f.store);
  const item = store.all()[0];
  if (!item) throw new Error("missing invocation");
  f.emit(threadId(item.threadId), "thread.session-set", {
    session: makeSession({
      threadId: threadId(item.threadId),
      providerThreadId: "native",
    }),
  });
  await vi.waitFor(() => {
    expect(f.passes.sessions.resolve("native")).toBeDefined();
  });
  f.passes.close();
  f.store.status("run", "failed");
  await retirePass(item, f.options, store, f.passes.sessions);
  expect(store.get(item.key)).toMatchObject({
    phase: "retired",
    binding: null,
    registrationNames: [],
  });
  expect(f.registrations.size).toBe(0);
  expect(f.passes.sessions.resolve("native")).toBeUndefined();
});

it("keeps persisted retirement terminal even when an older active writer finishes", async () => {
  const f = passFixture();
  await f.start();
  const store = new PassStore(f.store);
  const item = store.all()[0];
  if (!item) throw new Error("missing invocation");
  store.save({ ...item, phase: "retired", binding: null });
  store.save(item);
  expect(store.get(item.key)).toMatchObject({
    phase: "retired",
    binding: null,
  });
});

it("holds an initial turn when pause arrives during registration and starts it once after resume", async () => {
  const f = passFixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = vi
    .mocked(f.client.mcp.ensureRegistration)
    .getMockImplementation();
  vi.mocked(f.client.mcp.ensureRegistration).mockImplementationOnce(
    async (input) => {
      await held;
      await original?.(input);
    },
  );
  await f.engine.start({
    id: "run",
    blueprintId: "inspection",
    commit: "pinned",
    context: { item: "parcel" },
  });
  await vi.waitFor(() => {
    expect(f.client.mcp.ensureRegistration).toHaveBeenCalledTimes(1);
  });
  f.engine.pauseInstance("run");
  release();
  await f.passes.recover();
  expect(f.commands).toEqual([]);
  expect(f.store.get("run").status).toBe("awaiting");
  await f.engine.resumeInstance("run");
  await vi.waitFor(() => {
    expect(f.commands).toHaveLength(1);
  });
  expect(f.commands[0]?.type).toBe("thread.turn.start");
});

it("clears a committed remote registration when its acknowledgement is lost", async () => {
  const f = passFixture();
  vi.mocked(f.client.mcp.ensureRegistration).mockImplementationOnce(
    async (input) => {
      f.registrations.set(
        `${input.threadId}:${input.name ?? "default"}`,
        input,
      );
      await Promise.reject(new Error("registration acknowledgement lost"));
    },
  );
  await f.engine.start({
    id: "run",
    blueprintId: "inspection",
    commit: "pinned",
    context: { item: "parcel" },
  });
  await vi.waitFor(() => {
    expect(f.store.get("run").status).toBe("failed");
    expect(f.registrations.size).toBe(0);
  });
  expect(f.commands).toEqual([]);
  expect(new PassStore(f.store).all()[0]).toMatchObject({
    phase: "retired",
    binding: null,
    registrationNames: [],
  });
});

it("contains a background subscription failure and retires active registration", async () => {
  const f = passFixture();
  await f.start();
  vi.spyOn(f.client.threads, "watch").mockImplementationOnce(
    async function* () {
      yield* [];
      await Promise.reject(new Error("subscription failed"));
    },
  );
  await expect(f.restart()).rejects.toThrow("subscription failed");
  await vi.waitFor(() => {
    expect(f.store.get("run").status).toBe("failed");
    expect(f.registrations.size).toBe(0);
  });
  expect(
    f.store.events("run").filter((event) => event.type === "failure"),
  ).toHaveLength(1);
});
