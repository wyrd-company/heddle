// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IAsyncContext } from "flowcraft";
import { afterEach, describe, expect, it } from "vitest";

import type { LifecycleBlueprint } from "../engine/index.js";
import { SqlitePersistence } from "../persistence/index.js";
import { DurableAttentionQueue } from "./durable-adapters.js";
import { createLifecyclePrimitiveEffects } from "./lifecycle-primitives.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const asyncContext = (data: Record<string, unknown>): IAsyncContext => ({
  delete: async (key: string) => delete data[key],
  get: async (key: string) => data[key],
  has: async (key: string) => key in data,
  patch: async () => undefined,
  set: async (key: string, value: unknown) => {
    data[key] = value;
  },
  toJSON: async () => ({ ...data }),
  type: "async",
});

const blueprint = { edges: [], id: "sample", nodes: [] } as LifecycleBlueprint;

const harness = async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "heddle-primitives-"));
  directories.push(stateDirectory);
  const persistence = new SqlitePersistence({ stateDirectory });
  const attention = new DurableAttentionQueue(persistence);
  const effects = createLifecyclePrimitiveEffects({ attention, persistence });
  return { attention, effects, persistence };
};

const run = (
  effect: ReturnType<typeof createLifecyclePrimitiveEffects>[
    "fail" | "resolve-attention"],
  data: Record<string, unknown>,
  params: Record<string, unknown> = {},
) =>
  effect({
    blueprint,
    context: asyncContext(data),
    idempotencyKey: "sample",
    input: undefined,
    nodeId: "stop",
    params,
  });

describe("fail primitive", () => {
  it("raises attention with the rendered message and reports failure", async () => {
    const { attention, effects, persistence } = await harness();
    persistence.writeReconcilerRuntime({
      boardStatus: "in-progress",
      instanceId: "instance-f",
      state: "running",
      taskId: 17,
    });
    const output = await run(
      effects.fail,
      {
        _heddleInstanceId: "instance-f",
        lifecycle: {
          blueprint: { metadata: {} },
          current: { node: "confirm", visit: 2 },
          outputs: { confirm: { answers: { why: { text: "Too risky" } } } },
          task: { id: 17 },
          visits: { confirm: 2 },
        },
      },
      {
        __heddleNodeId: "stop",
        message:
          "Task {{ task.id }} stopped: {{ lifecycle.outputs.confirm.answers.why.text }}",
      },
    );
    expect(output).toEqual({
      failed: true,
      message: "Task 17 stopped: Too risky",
    });
    expect(persistence.listAttention()).toEqual([
      expect.objectContaining({
        attentionId: "lifecycle:failed:instance-f:stop:1",
        payload: expect.objectContaining({
          code: "lifecycle-failed",
          instanceId: "instance-f",
          message: "Task 17 stopped: Too risky",
          taskId: 17,
        }),
      }),
    ]);
    // Re-running the node (at-least-once) raises nothing new.
    await run(
      effects.fail,
      { _heddleInstanceId: "instance-f", lifecycle: { task: { id: 17 } } },
      { __heddleNodeId: "stop", message: "Task {{ task.id }} stopped again" },
    );
    expect(await attention.has("lifecycle:failed:instance-f:stop:1")).toBe(
      true,
    );
    expect(persistence.listAttention()).toHaveLength(1);
    persistence.close();
  });

  it("raises a fresh attention when the node recurs on a later visit", async () => {
    const { effects, persistence } = await harness();
    persistence.writeReconcilerRuntime({
      boardStatus: "in-progress",
      instanceId: "instance-f",
      state: "running",
      taskId: 17,
    });
    // The projection counts finished visits; the running visit is the next.
    const visit = (n: number) => ({
      _heddleInstanceId: "instance-f",
      lifecycle: { task: { id: 17 }, visits: { stop: n - 1 } },
    });
    const params = { __heddleNodeId: "stop", message: "Stopped" };
    await run(effects.fail, visit(1), params);
    // At-least-once execution of the same visit raises nothing new...
    await run(effects.fail, visit(1), params);
    // ...and the next visit of the same node is its own occurrence.
    await run(effects.fail, visit(2), params);
    expect(
      persistence.listAttention().map(({ attentionId }) => attentionId),
    ).toEqual([
      "lifecycle:failed:instance-f:stop:1",
      "lifecycle:failed:instance-f:stop:2",
    ]);
    persistence.close();
  });

  it("requires a message and fails closed on data the graph lacks", async () => {
    const { effects, persistence } = await harness();
    await expect(
      run(
        effects.fail,
        { _heddleInstanceId: "instance-f" },
        { __heddleNodeId: "stop" },
      ),
    ).rejects.toThrow(/requires a non-empty params.message/);
    await expect(
      run(
        effects.fail,
        { _heddleInstanceId: "instance-f", lifecycle: { task: null } },
        {
          __heddleNodeId: "stop",
          message: "{{ lifecycle.outputs.missing.x }}",
        },
      ),
    ).rejects.toThrow(/failed to render/);
    expect(persistence.listAttention()).toEqual([]);
    persistence.close();
  });
});

describe("resolve-attention primitive", () => {
  it("resolves the attention the lifecycle was started for, once", async () => {
    const { attention, effects, persistence } = await harness();
    await attention.raise({
      attentionId: "production:sample-condition",
      code: "sample-condition",
      error: { cause: null, message: "sample", name: "Error" },
      incidentId: "instance-r",
      instanceId: null,
      kind: "production-error",
      message: "A sample condition",
      taskId: 17,
    });
    const data = {
      _heddleInstanceId: "instance-r",
      _heddleSourceAttentionId: "production:sample-condition",
    };
    await expect(run(effects["resolve-attention"], data)).resolves.toEqual({
      attentionId: "production:sample-condition",
      resolved: true,
    });
    await expect(run(effects["resolve-attention"], data)).resolves.toEqual({
      attentionId: "production:sample-condition",
      resolved: false,
    });
    persistence.close();
  });

  it("resolves a reopened attention again for the occurrence that owns it", async () => {
    const { attention, effects, persistence } = await harness();
    await attention.raise({
      attentionId: "production:sample-condition",
      code: "sample-condition",
      error: { cause: null, message: "sample", name: "Error" },
      incidentId: "instance-r",
      instanceId: null,
      kind: "production-error",
      message: "A sample condition",
      taskId: 17,
    });
    const data = (instanceId: string) => ({
      _heddleInstanceId: instanceId,
      _heddleSourceAttentionId: "production:sample-condition",
    });
    await run(effects["resolve-attention"], data("instance-r"));
    // The condition recurs: the operator or a later episode reopens it and a
    // second incident occurrence resolves it under its own justification.
    expect(attention.reopen("production:sample-condition")).toBe(true);
    await expect(
      run(effects["resolve-attention"], data("instance-r-2")),
    ).resolves.toEqual({
      attentionId: "production:sample-condition",
      resolved: true,
    });
    expect(
      persistence.getAttention("production:sample-condition"),
    ).toMatchObject({
      resolutionJustification: "instance-r-2",
    });
    // The first occurrence's replay is inert against the new resolution.
    await expect(
      run(effects["resolve-attention"], data("instance-r")),
    ).resolves.toEqual({
      attentionId: "production:sample-condition",
      resolved: false,
    });
    expect(
      persistence.getAttention("production:sample-condition"),
    ).toMatchObject({
      resolutionJustification: "instance-r-2",
    });
    persistence.close();
  });

  it("fails closed when the lifecycle was not started for an attention", async () => {
    const { effects, persistence } = await harness();
    await expect(
      run(effects["resolve-attention"], { _heddleInstanceId: "instance-r" }),
    ).rejects.toThrow(/none is recorded in the context/);
    persistence.close();
  });
});
