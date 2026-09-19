// ---
// relationships:
//   verifies: agent-tools
// ---
import { expect, it, vi } from "vitest";
import { HookServer } from "../src/agent-tools/index.js";
import { passFixture } from "./support/pass-fixture.js";
import { makeSession } from "../src/t3code/test/support/thread-fixtures.js";

async function startedPass() {
  const f = passFixture();
  await f.start();
  const command = f.commands[0];
  if (command?.type !== "thread.turn.start") throw new Error("missing start");
  const thread = command.threadId;
  const session = (overrides: Record<string, unknown> = {}) => {
    f.emit(thread, "thread.session-set", {
      session: makeSession({
        threadId: thread,
        status: "running",
        ...overrides,
      }),
    });
  };
  return { f, thread, session };
}

it("reads the native session identity once the provider session is running", async () => {
  const { f, thread, session } = await startedPass();
  f.nativeSessions.set(thread, " session/A B-1 ");
  session();
  await vi.waitFor(() => {
    expect(f.passes.sessions.resolve(" session/A B-1 ")?.threadId).toBe(thread);
  });
  expect(f.nativeLookups).toEqual([thread]);
  expect(f.passes.read("run", "inspect")?.nativeSessionId).toBe(
    " session/A B-1 ",
  );
  expect(f.passes.read("run", "inspect")?.usageSessionId).toBe(
    " session/A B-1 ",
  );
});

it("asks again on the next session event when the identity is not known yet", async () => {
  const { f, thread, session } = await startedPass();
  session();
  await vi.waitFor(() => {
    expect(f.nativeLookups).toEqual([thread]);
  });
  expect(f.passes.read("run", "inspect")?.nativeSessionId).toBeNull();
  f.nativeSessions.set(thread, "native-late");
  session();
  await vi.waitFor(() => {
    expect(f.passes.sessions.resolve("native-late")).toBeDefined();
  });
  expect(f.nativeLookups).toEqual([thread, thread]);
});

it("does not ask on ordinary activity events or once the identity is known", async () => {
  const { f, thread, session } = await startedPass();
  f.nativeSessions.set(thread, "native-known");
  session();
  await vi.waitFor(() => {
    expect(f.nativeLookups).toEqual([thread]);
  });
  for (let index = 0; index < 3; index++)
    f.emit(thread, "thread.activity-appended", {
      activity: {
        id: `activity-${String(index)}`,
        tone: "info",
        kind: "context-window.updated",
        summary: "fixture activity",
        payload: { usedTokens: 10, maxTokens: 1000 },
        turnId: null,
        createdAt: f.at,
      },
    });
  session();
  await vi.waitFor(() => {
    expect(f.passes.read("run", "inspect")?.contextRatio).toBe(0.01);
  });
  expect(f.nativeLookups).toEqual([thread]);
});

it("asks again and overwrites when the provider session is replaced", async () => {
  const { f, thread, session } = await startedPass();
  f.nativeSessions.set(thread, "native-alpha");
  session({ providerName: "sample-alpha" });
  await vi.waitFor(() => {
    expect(f.passes.sessions.resolve("native-alpha")).toBeDefined();
  });
  f.nativeSessions.set(thread, "native-beta");
  session({ providerName: "sample-beta" });
  await vi.waitFor(() => {
    expect(f.passes.sessions.resolve("native-beta")?.threadId).toBe(thread);
  });
  expect(f.passes.sessions.resolve("native-alpha")).toBeUndefined();
});

it("clears the identity when the provider session stops", async () => {
  const { f, thread, session } = await startedPass();
  f.nativeSessions.set(thread, "native-stopping");
  session();
  await vi.waitFor(() => {
    expect(f.passes.sessions.resolve("native-stopping")).toBeDefined();
  });
  session({ status: "stopped" });
  await vi.waitFor(() => {
    expect(f.passes.read("run", "inspect")?.nativeSessionId).toBeNull();
  });
  expect(f.passes.sessions.resolve("native-stopping")).toBeUndefined();
});

it("records a failed read as attention and keeps the pass running", async () => {
  const { f, thread, session } = await startedPass();
  vi.mocked(f.client.mcp.nativeSessionId).mockRejectedValueOnce(
    new Error("sample transport failure"),
  );
  session();
  await vi.waitFor(() => {
    expect(
      f.store.events("run").some((event) => event.type === "attention"),
    ).toBe(true);
  });
  expect(f.store.get("run").status).toBe("awaiting");
  f.nativeSessions.set(thread, "native-after-failure");
  session();
  await vi.waitFor(() => {
    expect(f.passes.sessions.resolve("native-after-failure")).toBeDefined();
  });
});

it("reads the identity again for a recovered pass whose identity is unknown", async () => {
  const { f, thread, session } = await startedPass();
  session();
  await vi.waitFor(() => {
    expect(f.nativeLookups).toEqual([thread]);
  });
  f.nativeSessions.set(thread, "native-recovered");
  await f.restart();
  await vi.waitFor(() => {
    expect(f.passes.sessions.resolve("native-recovered")?.threadId).toBe(
      thread,
    );
  });
});

it("decides a Stop hook from Heddle's own table without asking T3 Code", async () => {
  const { f, thread, session } = await startedPass();
  f.nativeSessions.set(thread, "native-hooked");
  session();
  await vi.waitFor(() => {
    expect(f.passes.sessions.resolve("native-hooked")).toBeDefined();
  });
  const hooks = new HookServer(f.passes.sessions, f.options.toolOrigin);
  const lookups = f.nativeLookups.length;
  const operations = f.operations.length;
  expect(await hooks.decide("unknown-session")).toEqual({});
  expect(f.nativeLookups.length).toBe(lookups);
  expect(f.operations.length).toBe(operations);
});
