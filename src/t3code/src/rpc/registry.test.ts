// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { describe, expect, expectTypeOf, it } from "vitest";
import { rpcMethods, type RpcMethods, type RpcMethodName } from "./registry.js";
import type { RpcPayload, RpcSuccess, StreamMethodName, UnaryMethodName } from "./spec.js";
import { VcsStatusStreamEvent } from "../schemas/vcs.js";
import { TerminalAttachStreamEvent } from "../schemas/terminal.js";

const expected = {
  "orchestration.dispatchCommand": [false, "orchestration:operate"],
  "orchestration.getWorkflowScript": [false, "orchestration:read"],
  "orchestration.getTurnDiff": [false, "orchestration:read"],
  "orchestration.getFullThreadDiff": [false, "orchestration:read"],
  "orchestration.searchThreads": [false, "orchestration:read"],
  "orchestration.getArchivedShellSnapshot": [false, "orchestration:read"],
  "orchestration.subscribeShell": [true, "orchestration:read"],
  "orchestration.subscribeThread": [true, "orchestration:read"],
  "server.probe": [false, "orchestration:read"],
  "server.getConfig": [false, "orchestration:read"],
  "server.getSettings": [false, "orchestration:read"],
  "server.refreshProviders": [false, "orchestration:operate"],
  subscribeServerConfig: [true, "orchestration:read"],
  subscribeServerLifecycle: [true, "orchestration:read"],
  subscribeAuthAccess: [true, "access:read"],
  "vcs.listRefs": [false, "orchestration:read"],
  "vcs.refreshStatus": [false, "orchestration:read"],
  "vcs.createWorktree": [false, "orchestration:operate"],
  "vcs.removeWorktree": [false, "orchestration:operate"],
  "vcs.createRef": [false, "orchestration:operate"],
  "vcs.switchRef": [false, "orchestration:operate"],
  subscribeVcsStatus: [true, "orchestration:read"],
  subscribeWorktreeSetup: [true, "orchestration:read"],
  "worktreeSetup.cancel": [false, "orchestration:operate"],
  "projects.listEntries": [false, "orchestration:read"],
  "projects.readFile": [false, "orchestration:read"],
  "projects.writeFile": [false, "orchestration:operate"],
  "projects.searchEntries": [false, "orchestration:read"],
  "projects.searchContents": [false, "orchestration:read"],
  "terminal.open": [false, "terminal:operate"],
  "terminal.attach": [true, "terminal:operate"],
  "terminal.write": [false, "terminal:operate"],
  "terminal.resize": [false, "terminal:operate"],
  "terminal.close": [false, "terminal:operate"],
  subscribeTerminalEvents: [true, "terminal:operate"],
} as const;

describe("RPC contract registry", () => {
  it("covers exactly the design's wire methods, with fork scopes and stream flags", () => {
    expect(Object.keys(rpcMethods).sort()).toEqual(Object.keys(expected).sort());
    for (const name of Object.keys(expected) as RpcMethodName[]) {
      expect([rpcMethods[name].stream, rpcMethods[name].scope], name).toEqual(expected[name]);
    }
  });
  it("retains payload, success, and stream types", () => {
    expectTypeOf<"terminal.attach">().toExtend<StreamMethodName<RpcMethods>>();
    expectTypeOf<"terminal.attach">().not.toExtend<UnaryMethodName<RpcMethods>>();
    expectTypeOf<
      RpcPayload<RpcMethods, "projects.readFile">["relativePath"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      RpcSuccess<RpcMethods, "orchestration.dispatchCommand">["sequence"]
    >().toEqualTypeOf<number>();
  });
  it("validates optional server subscription and refresh flags", () => {
    const schema = rpcMethods.subscribeServerConfig.payload;
    expect(schema.parse({})).toEqual({});
    expect(
      schema.parse({ environmentThemes: true, usageLimitSources: true, usageLimitsCommand: false }),
    ).toEqual({ environmentThemes: true, usageLimitSources: true, usageLimitsCommand: false });
    expect(schema.safeParse({ usageLimitsCommand: "yes" }).success).toBe(false);
    expect(
      rpcMethods["server.refreshProviders"].payload.safeParse({
        instanceId: "example",
        cwd: "/tmp/example",
        refreshModels: true,
      }).success,
    ).toBe(true);
  });
  it("models omitted unary success values as void", () => {
    for (const name of [
      "terminal.write",
      "terminal.resize",
      "terminal.close",
      "vcs.removeWorktree",
    ] as const) {
      expect(rpcMethods[name].success.safeParse(undefined).success).toBe(true);
      expect(rpcMethods[name].success.safeParse({}).success).toBe(false);
    }
  });
  it("uses the fork's _tag discriminator for VCS streams", () => {
    expect(VcsStatusStreamEvent.parse({ _tag: "remoteUpdated", remote: null })).toEqual({
      _tag: "remoteUpdated",
      remote: null,
    });
    expect(VcsStatusStreamEvent.parse({ _tag: "future", data: 1 })).toEqual({
      unknown: true,
      raw: { _tag: "future", data: 1 },
    });
    expect(VcsStatusStreamEvent.safeParse({ _tag: "localUpdated", local: {} }).success).toBe(false);
  });
  it("decodes terminal attach updates and unfamiliar events", () => {
    expect(
      TerminalAttachStreamEvent.parse({
        type: "output",
        threadId: "thread-1",
        terminalId: "term-1",
        data: "output",
        sequence: 1,
      }),
    ).toMatchObject({ type: "output", data: "output" });
    expect(TerminalAttachStreamEvent.parse({ type: "future" })).toEqual({
      unknown: true,
      raw: { type: "future" },
    });
  });
  it("requires explicit terminal identifiers and valid sizes", () => {
    expect(
      rpcMethods["terminal.open"].payload.safeParse({ threadId: "thread-1", cwd: "/tmp/example" })
        .success,
    ).toBe(false);
    expect(
      rpcMethods["terminal.resize"].payload.safeParse({
        threadId: "thread-1",
        terminalId: "term-1",
        cols: 0,
        rows: 24,
      }).success,
    ).toBe(false);
    expect(rpcMethods["terminal.close"].payload.parse({ threadId: "thread-1" })).toEqual({
      threadId: "thread-1",
    });
  });
});
