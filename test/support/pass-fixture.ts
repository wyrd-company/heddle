// ---
// relationships:
//   verifies: node-types
// ---
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import type { WorkflowBlueprint } from "flowcraft";
import { RunStore, WorkflowEngine } from "../../src/engine/index.js";
import { templateSource } from "./templates.js";
import { PassService, type PassOptions } from "../../src/pass/index.js";
import {
  applyThreadEvent,
  schemas,
  type ThreadWatchItem,
  type ClientOrchestrationCommand,
  type OrchestrationThread,
  type ExternalMcpRegistration,
} from "../../src/t3code/index.js";
import {
  makeShellProject,
  makeShellThread,
  makeThread,
  rawEvent,
  at,
} from "../../src/t3code/test/support/thread-fixtures.js";
import { ThreadProjectionTracker } from "../../src/t3code/src/api/thread-tracker.js";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

export const blueprint: WorkflowBlueprint = {
  id: "inspection",
  nodes: [
    {
      id: "inspect",
      uses: "pass",
      params: {
        prompt: { inline: "Inspect {{ item }}" },
        handoff: {
          type: "object",
          description: "Submit the result",
          properties: { accepted: { type: "boolean" } },
          required: ["accepted"],
        },
      },
    },
    { id: "finish", uses: "finish" },
  ],
  edges: [
    {
      source: "inspect",
      target: "finish",
      condition:
        "result.output.handoff or result.output.turnEnded or result.output.timeout",
    },
  ],
};
export function passFixture(
  plan = blueprint,
  overrides: Partial<PassOptions> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "pass-fixture-"));
  cleanup.push(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const store = new RunStore(join(root, "runs.sqlite"));
  cleanup.push(() => {
    store.close();
  });
  const threads = new Map<string, OrchestrationThread>();
  const registrations = new Map<string, ExternalMcpRegistration>();
  const nativeSessions = new Map<string, string>();
  const nativeLookups: string[] = [];
  const operations: string[] = [];
  const commands: ClientOrchestrationCommand[] = [];
  const committed = new Set<string>();
  const queues = new Map<
    string,
    Set<{ push: (item: ThreadWatchItem) => void }>
  >();
  let sequence = 0;
  const history: Extract<ThreadWatchItem, { kind: "event" }>[] = [];
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const project = makeShellProject({ workspaceRoot: workspace });
  const client: PassOptions["client"] = {
    projects: {
      ensure: vi.fn(() => Promise.resolve(project)),
      findByWorkspaceRoot: () => Promise.resolve(project),
    },
    threads: {
      ensure: vi.fn<PassOptions["client"]["threads"]["ensure"]>((input) => {
        if (!threads.has(input.threadId))
          threads.set(
            input.threadId,
            makeThread({
              id: input.threadId,
              modelSelection: input.modelSelection,
            }),
          );
        return Promise.resolve(
          makeShellThread({
            id: input.threadId,
            modelSelection: input.modelSelection,
          }),
        );
      }),
      get: (id) =>
        Promise.resolve(threads.has(id) ? makeShellThread({ id }) : undefined),
      dispatch: vi.fn<PassOptions["client"]["threads"]["dispatch"]>(
        (command) => {
          operations.push(command.type);
          commands.push(command);
          if (!committed.has(command.commandId)) {
            committed.add(command.commandId);
            if (command.type === "thread.turn.start")
              emit(command.threadId, "thread.message-sent", {
                messageId: command.message.messageId,
                role: "user",
                text: command.message.text,
                turnId: null,
                streaming: false,
                createdAt: at,
                updatedAt: at,
              });
          }
          return Promise.resolve({ sequence });
        },
      ),
      watch: (id, options) => ({
        async *[Symbol.asyncIterator]() {
          const tracker = new ThreadProjectionTracker();
          let wake: (() => void) | undefined;
          const items: ThreadWatchItem[] = [];
          const queue = {
            push: (item: ThreadWatchItem) => {
              items.push(item);
              wake?.();
            },
          };
          const subscriptions = queues.get(id) ?? new Set();
          subscriptions.add(queue);
          queues.set(id, subscriptions);
          const close = () => wake?.();
          options?.signal?.addEventListener("abort", close);
          try {
            const thread = threads.get(id);
            if (!thread) throw new Error("missing thread");
            yield {
              kind: "snapshot",
              snapshot: {
                thread: structuredClone(thread),
                snapshotSequence: sequence,
              },
            };
            yield* tracker.seed({
              thread: structuredClone(thread),
              snapshotSequence: sequence,
            });
            if (options?.afterSequence !== undefined)
              for (const replay of history) {
                if (
                  "unknown" in replay.event ||
                  replay.event.aggregateId !== id ||
                  replay.event.sequence <= options.afterSequence
                )
                  continue;
                yield replay;
                yield* tracker.apply(replay.event);
              }
            yield { kind: "synchronized" };
            while (!options?.signal?.aborted) {
              if (!items.length)
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
              const item = items.shift();
              if (item) {
                yield item;
                if (item.kind === "event") yield* tracker.apply(item.event);
              }
            }
          } finally {
            subscriptions.delete(queue);
            options?.signal?.removeEventListener("abort", close);
          }
        },
      }),
    },
    mcp: {
      ensureRegistration: vi.fn<
        PassOptions["client"]["mcp"]["ensureRegistration"]
      >((input) => {
        operations.push(`register:${input.name ?? "default"}`);
        registrations.set(
          `${input.threadId}:${input.name ?? "default"}`,
          input,
        );
        return Promise.resolve();
      }),
      nativeSessionId: vi.fn<PassOptions["client"]["mcp"]["nativeSessionId"]>(
        (input) => {
          nativeLookups.push(input.threadId);
          return Promise.resolve(nativeSessions.get(input.threadId) ?? null);
        },
      ),
      clear: vi.fn<PassOptions["client"]["mcp"]["clear"]>((input) => {
        operations.push(`clear:${input.name ?? "default"}`);
        registrations.delete(`${input.threadId}:${input.name ?? "default"}`);
        return Promise.resolve();
      }),
    },
  };
  const options: PassOptions = {
    client,
    toolOrigin: "http://127.0.0.1:1234",
    defaultModel: schemas.orchestrationModel.ModelSelection.parse({
      instanceId: "sample-provider",
      model: "sample-model",
    }),
    defaultWorktree: workspace,
    templates: templateSource(() =>
      Promise.reject(new Error("unexpected artifact read")),
    ),
    ...overrides,
  };
  let passes: PassService;
  const engine = new WorkflowEngine(store, {
    resolveBlueprint: () => Promise.resolve(plan),
    nodes: {
      pass: (context) => passes.node(context),
      finish: () => Promise.resolve(null),
    },
    onBoundary: (run) => passes.synchronize(run),
  });
  passes = new PassService(engine, options);
  cleanup.push(() => {
    passes.close();
  });
  const emit = (id: string, type: string, payload: Record<string, unknown>) => {
    const event = schemas.orchestrationEvents.OrchestrationEvent.parse({
      ...rawEvent(++sequence, type, { threadId: id, ...payload }),
      aggregateId: id,
    });
    history.push({ kind: "event", event });
    const current = threads.get(id);
    if (current) threads.set(id, applyThreadEvent(current, event));
    for (const queue of queues.get(id) ?? [])
      queue.push({ kind: "event", event });
  };
  const start = async () => {
    const run = await engine.start({
      id: "run",
      blueprintId: plan.id,
      commit: "pinned",
      context: { item: "parcel" },
    });
    await vi.waitFor(() => {
      if (
        commands.filter((command) => command.type === "thread.turn.start")
          .length !== 1
      )
        throw new Error("first turn not dispatched");
    });
    return run;
  };
  const restart = async () => {
    passes.close();
    passes = new PassService(engine, options);
    await passes.recover();
    await vi.waitFor(() => {
      if (vi.mocked(client.mcp.ensureRegistration).mock.calls.length < 2)
        throw new Error("not registered");
    });
    return passes;
  };
  return {
    root,
    store,
    engine,
    get passes() {
      return passes;
    },
    client,
    options,
    threads,
    registrations,
    nativeSessions,
    nativeLookups,
    operations,
    commands,
    committed,
    emit,
    start,
    restart,
    at,
  };
}
