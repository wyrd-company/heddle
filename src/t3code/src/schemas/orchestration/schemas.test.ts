import { OrchestrationMessageContext } from "./commands/message-context.js";
// ---
// relationships:
//   implements:
//     - t3-code-client
//     - agent-tools
//     - node-types
// ---
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "../server.js";
import { ExecutionEnvironmentDescriptor } from "../environment.js";
import { ModelSelection, SnapShotAccessibility, ProjectMonogramText } from "./model.js";
import { ClientOrchestrationCommand, ThreadMetaUpdateCommand } from "./commands.js";
import { OrchestrationEvent } from "./events.js";
import {
  OrchestrationSession,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
} from "./read-model.js";
import { OrchestrationShellSnapshot } from "./shell.js";
import { ProviderOptionSelections, ServerProvider } from "../provider.js";
import { openRequests, UserInputRequestedPayload } from "./activities.js";
import { OrchestrationGetTurnDiffInput } from "./stream.js";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../../test/fixtures/${name}.json`, import.meta.url), "utf8"),
  );
}

describe("captured fork payloads", () => {
  it.each([
    ["server-config", ServerConfig],
    ["orchestration-shell", OrchestrationShellSnapshot],
    ["orchestration-thread-detail", OrchestrationThreadDetailSnapshot],
    ["environment", ExecutionEnvironmentDescriptor],
  ] as const)("decodes %s", (name, schema) => {
    expect(schema.safeParse(fixture(name))).toMatchObject({ success: true });
  });
  it("retains the captured providers rather than silently dropping them", () => {
    const raw = fixture("server-config") as { providers: unknown[] };
    const parsed = ServerConfig.parse(raw);
    expect(parsed.providers).toHaveLength(raw.providers.length);
    for (const provider of raw.providers)
      expect(ServerProvider.safeParse(provider).success).toBe(true);
  });
});

describe("forward compatibility", () => {
  it("preserves an unknown event as an unknown variant", () => {
    const raw = { type: "thread.future-event", payload: { data: 1 } };
    expect(OrchestrationEvent.parse(raw)).toEqual({ unknown: true, raw });
  });
  it("rejects malformed known events", () => {
    expect(OrchestrationEvent.safeParse({ type: "thread.created", payload: {} }).success).toBe(
      false,
    );
  });
  it("keeps unknown activity kinds and tones", () => {
    const activity = {
      id: "activity-1",
      kind: "future.activity",
      tone: "future-tone",
      summary: "Example",
      payload: {},
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
    };
    expect(OrchestrationThreadActivity.parse(activity)).toEqual(activity);
  });
  it("promotes legacy model routing and retains future fields", () => {
    expect(
      ModelSelection.parse({ provider: "example", model: "model-1", future: true }),
    ).toMatchObject({ instanceId: "example", model: "model-1", future: true });
    expect(
      ModelSelection.parse({ provider: "old", instanceId: "new", model: "model-1" }).instanceId,
    ).toBe("new");
    expect(
      ModelSelection.safeParse({ instanceId: null, provider: "old", model: "model-1" }).success,
    ).toBe(false);
  });
  it("normalizes legacy provider option selections", () => {
    expect(
      ProviderOptionSelections.parse({ effort: " high ", fast: true, invalid: 42, blank: " " }),
    ).toEqual([
      { id: "effort", value: "high" },
      { id: "fast", value: true },
    ]);
  });
});

describe("command validation", () => {
  it("requires commandId", () => {
    expect(
      ClientOrchestrationCommand.safeParse({ type: "thread.delete", threadId: "thread-1" }).success,
    ).toBe(false);
    expect(
      ClientOrchestrationCommand.safeParse({
        type: "thread.delete",
        threadId: "thread-1",
        commandId: "command-1",
      }).success,
    ).toBe(true);
  });
  it("rejects unknown commands and reversed turn ranges", () => {
    expect(
      ClientOrchestrationCommand.safeParse({
        type: "thread.future",
        commandId: "command-1",
        threadId: "thread-1",
      }).success,
    ).toBe(false);
    expect(
      OrchestrationGetTurnDiffInput.safeParse({
        threadId: "thread-1",
        fromTurnCount: 2,
        toTurnCount: 1,
      }).success,
    ).toBe(false);
  });
});

describe("pending requests", () => {
  const request = (kind: string, requestId: string, extra = {}) => ({
    kind,
    payload: { requestId, ...extra },
  });
  it.each(["approval", "user-input"])("clears %s on resolution", (kind) => {
    const first = request(`${kind}.requested`, "request-1");
    const second = request(`${kind}.requested`, "request-2");
    const pending = openRequests([first, second, request(`${kind}.resolved`, "request-1")]);
    expect([...pending.values()]).toEqual([second]);
  });
  it.each([
    "stale pending approval request",
    "unknown pending approval request",
    "unknown pending permission request",
    "stale pending user-input request",
    "unknown pending user-input request",
    "unknown pending user input request",
    "unknown pending codex user input request",
  ])("clears stale failure: %s", (detail) => {
    for (const kind of ["approval", "user-input"]) {
      expect(
        openRequests([
          request(`${kind}.requested`, "request-1"),
          request(`provider.${kind}.respond.failed`, "request-1", { detail: detail.toUpperCase() }),
        ]).size,
      ).toBe(0);
    }
  });
  it("keeps transient failures and ignores malformed request ids", () => {
    const first = request("approval.requested", "request-1");
    const pending = openRequests([
      first,
      request("provider.approval.respond.failed", "request-1", {
        detail: "Connection unavailable",
      }),
      { kind: "approval.resolved", payload: null },
      { kind: "approval.resolved", payload: { requestId: 3 } },
    ]);
    expect([...pending.values()]).toEqual([first]);
  });
  it("uses the last request with the same id, in activity order", () => {
    const replacement = request("user-input.requested", "request-1", { questions: [] });
    expect([
      ...openRequests([request("approval.requested", "request-1"), replacement]).values(),
    ]).toEqual([replacement]);
  });
  it("decodes runtime question options and optional headers", () => {
    const result = UserInputRequestedPayload.parse({
      requestId: "request-1",
      questions: [
        { id: "choice", question: "Which color?", multiSelect: true, options: [{ label: "Blue" }] },
      ],
    });
    expect(result.questions[0]?.multiSelect).toBe(true);
    expect(result.questions[0]?.options[0]?.label).toBe("Blue");
  });
});

describe("nested contract validation", () => {
  it("keeps future provider statuses in config arrays", () => {
    const raw = fixture("server-config") as { providers: Array<Record<string, unknown>> };
    const provider = raw.providers[0];
    expect(provider).toBeDefined();
    const value = ServerConfig.parse({
      ...raw,
      providers: [{ ...provider, status: "future-status", auth: { status: "future-auth" } }],
    });
    expect(value.providers).toHaveLength(1);
    expect(value.providers[0]?.status).toBe("future-status");
  });
  it("rejects conflicting title changes and unknown input modes", () => {
    expect(
      ThreadMetaUpdateCommand.safeParse({
        type: "thread.meta.update",
        commandId: "command-1",
        threadId: "thread-1",
        title: "Example",
        regenerateTitle: true,
      }).success,
    ).toBe(false);
    expect(
      ClientOrchestrationCommand.safeParse({
        type: "thread.runtime-mode.set",
        commandId: "command-1",
        threadId: "thread-1",
        runtimeMode: "future-mode",
        createdAt: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });
  it("drops malformed context records but rejects duplicate context ids", () => {
    const record = {
      version: 1,
      contextId: "context-1",
      label: "Example",
      kind: "mention",
      path: "/tmp/example",
    };
    expect(
      OrchestrationMessageContext.parse({ version: 1, records: [{ kind: "mention" }, record] })
        .records,
    ).toEqual([record]);
    expect(
      OrchestrationMessageContext.safeParse({ version: 1, records: [record, record] }).success,
    ).toBe(false);
  });
  it("retains future context payloads with their reference ids", () => {
    const record = {
      version: 1,
      contextId: "context-1",
      label: "Example",
      kind: "future-context",
      payload: { key: true },
    };
    expect(OrchestrationMessageContext.parse({ version: 1, records: [record] }).records).toEqual([
      record,
    ]);
  });
  it("decodes recursive accessibility trees and rejects malformed nodes", () => {
    const node = { role: "button", bounds: null, children: [] };
    const tree = {
      format: "element-tree",
      coordinateSpace: "captured-image",
      imageSize: { width: 10, height: 10 },
      truncated: false,
      root: { ...node, children: [node] },
    };
    expect(SnapShotAccessibility.safeParse(tree).success).toBe(true);
    expect(SnapShotAccessibility.safeParse({ ...tree, root: { children: [] } }).success).toBe(
      false,
    );
    expect(
      SnapShotAccessibility.safeParse({ format: "flat-text", text: "", truncated: false }).success,
    ).toBe(false);
  });
  it("bounds monograms by graphemes", () => {
    expect(ProjectMonogramText.safeParse("AB").success).toBe(true);
    expect(ProjectMonogramText.safeParse("ABC").success).toBe(false);
    expect(ProjectMonogramText.safeParse("!").success).toBe(false);
  });
});

it("retains exact native session identity and decodes legacy omission as null", () => {
  const legacy = {
    threadId: "sample-thread",
    status: "ready",
    providerName: "codex",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-01-01T00:00:00Z",
  };
  expect(OrchestrationSession.parse(legacy).providerThreadId).toBeNull();
  expect(
    OrchestrationSession.parse({ ...legacy, providerThreadId: " native-exact " }).providerThreadId,
  ).toBe(" native-exact ");
  expect(
    OrchestrationSession.parse({ ...legacy, providerThreadId: null }).providerThreadId,
  ).toBeNull();
});
