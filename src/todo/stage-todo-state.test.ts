// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it, vi } from "vitest";

import type { InstanceRecord, InstanceState } from "../persistence/index.js";
import { resolvedSessionBindingFixture } from "../persistence/resolved-session-binding.test-support.js";
import {
  ensureStageTodoList,
  mutateStageTodoList,
  stageTodoStateForHandoff,
} from "./stage-todo-state.js";

const state = (): InstanceState => ({
  correlationTokens: {},
  flowcraftContext: null,
  handoffs: [],
  todoState: null,
});

const input = {
  instanceId: "instance-one",
  repositoryRoot: "/workspaces/sample-repository",
  sessionKey: "inspect-one",
  stage: "inspect",
  taskContract: { title: "Inspect a sample" },
  templateId: "sample-inspect",
};

const instantiate = vi.fn(async () => ({
  items: [{ checked: false, id: "orient", text: "Orient on the sample" }],
  sessionKey: input.sessionKey,
  stage: input.stage,
  template: input.templateId,
}));

describe("stage todo state", () => {
  it("retries compare-and-swap without losing another persisted stage list", async () => {
    let record: InstanceRecord = {
      instanceId: input.instanceId,
      state: state(),
      version: 1,
    };
    let collide = true;
    const store = {
      getInstance: () => record,
      compareAndSwapInstance: (
        _instanceId: string,
        version: number,
        nextState: InstanceState,
      ) => {
        if (collide) {
          collide = false;
          record = {
            ...record,
            state: {
              ...record.state,
              todoState: {
                format: "heddle.todo-state",
                lists: [
                  {
                    items: [],
                    sessionKey: "prepare-one",
                    stage: "prepare",
                    template: "sample-prepare",
                  },
                ],
                version: 1,
              },
            },
            version: 2,
          };
          return undefined;
        }
        if (version !== record.version) return undefined;
        record = { ...record, state: nextState, version: record.version + 1 };
        return record;
      },
    };

    await expect(
      ensureStageTodoList(store, input, instantiate),
    ).resolves.toMatchObject({
      lists: [{ sessionKey: "prepare-one" }, { sessionKey: "inspect-one" }],
    });
    expect(instantiate).toHaveBeenCalledOnce();
  });

  it("rejects reuse of a session key for another stage contract", async () => {
    const existing = state();
    existing.todoState = {
      format: "heddle.todo-state",
      lists: [
        {
          items: [],
          sessionKey: input.sessionKey,
          stage: "prepare",
          template: "sample-prepare",
        },
      ],
      version: 1,
    };
    const record: InstanceRecord = {
      instanceId: input.instanceId,
      state: existing,
      version: 1,
    };

    await expect(
      ensureStageTodoList(
        {
          getInstance: () => record,
          compareAndSwapInstance: () => record,
        },
        input,
        instantiate,
      ),
    ).rejects.toThrow("does not match stage contract");
  });

  it("rejects malformed persisted todo state before instantiation", async () => {
    const malformed = state();
    malformed.todoState = {
      format: "heddle.todo-state",
      lists: [
        {
          items: [{ checked: "yes", id: "orient", text: "Orient" }],
          sessionKey: "prepare-one",
          stage: "prepare",
          template: "sample-prepare",
        },
      ],
      version: 1,
    };
    const record: InstanceRecord = {
      instanceId: input.instanceId,
      state: malformed,
      version: 1,
    };

    await expect(
      ensureStageTodoList(
        {
          getInstance: () => record,
          compareAndSwapInstance: () => record,
        },
        input,
        instantiate,
      ),
    ).rejects.toThrow("invalid todo state");
  });

  it("retries a todo mutation without overwriting a concurrent list write", () => {
    let record: InstanceRecord = {
      instanceId: input.instanceId,
      state: {
        ...state(),
        todoState: {
          format: "heddle.todo-state",
          lists: [
            {
              items: [
                {
                  checked: false,
                  id: "orient",
                  text: "Orient on the sample",
                },
              ],
              sessionKey: input.sessionKey,
              stage: input.stage,
              template: input.templateId,
            },
          ],
          version: 1,
        },
      },
      version: 1,
    };
    let collide = true;
    const store = {
      getInstance: () => record,
      compareAndSwapInstance: (
        _instanceId: string,
        version: number,
        nextState: InstanceState,
      ) => {
        if (collide) {
          collide = false;
          const todoState = record.state.todoState as {
            format: "heddle.todo-state";
            lists: Array<{
              items: Array<{ checked: boolean; id: string; text: string }>;
              sessionKey: string;
              stage: string;
              template: string;
            }>;
            version: 1;
          };
          record = {
            ...record,
            state: {
              ...record.state,
              todoState: {
                ...todoState,
                lists: todoState.lists.map((list) => ({
                  ...list,
                  items: [
                    ...list.items,
                    {
                      checked: false,
                      id: "parallel",
                      text: "Preserve this concurrent item",
                    },
                  ],
                })),
              },
            },
            version: 2,
          };
          return undefined;
        }
        if (version !== record.version) return undefined;
        record = { ...record, state: nextState, version: record.version + 1 };
        return record;
      },
    };

    const updated = mutateStageTodoList(
      store,
      {
        instanceId: input.instanceId,
        sessionKey: input.sessionKey,
        stage: input.stage,
      },
      (list) => ({
        ...list,
        items: list.items.map((item) =>
          item.id === "orient" ? { ...item, checked: true } : item,
        ),
      }),
    );

    expect(updated.items).toEqual([
      { checked: true, id: "orient", text: "Orient on the sample" },
      {
        checked: false,
        id: "parallel",
        text: "Preserve this concurrent item",
      },
    ]);
  });

  it("projects todo handoff state without assignment bearer tokens or metadata", () => {
    const record: InstanceRecord = {
      instanceId: input.instanceId,
      state: {
        ...state(),
        todoState: {
          format: "heddle.todo-state",
          lists: [
            {
              assignments: [
                {
                  binding: resolvedSessionBindingFixture({
                    sessionKey: "child-session",
                    threadId: "child-thread",
                  }),
                  bootstrap: {
                    createCommandId: "create-child",
                    createdAt: new Date(0).toISOString(),
                    messageId: "message-child",
                    turnCommandId: "turn-child",
                  },
                  correlationToken: "secret-token",
                  depth: 1,
                  model: "sample-model",
                  operationId: "spawn-child",
                  parentSessionKey: input.sessionKey,
                  parentThreadId: "parent-thread",
                  provider: "sample-provider",
                  rootItemId: "orient",
                  secretMetadata: "secret-metadata",
                  sessionKey: "child-session",
                  status: "active",
                  threadId: "child-thread",
                },
              ],
              items: [
                { checked: false, id: "orient", text: "Orient on the sample" },
              ],
              sessionKey: input.sessionKey,
              stage: input.stage,
              template: input.templateId,
            },
          ],
          version: 1,
        },
      },
      version: 1,
    };

    const projected = stageTodoStateForHandoff(
      record,
      input.sessionKey,
      input.stage,
      [input.sessionKey],
    ).state;
    expect(projected.lists[0]).not.toHaveProperty("assignments");
    expect(JSON.stringify(projected)).not.toContain("secret-token");
    expect(JSON.stringify(projected)).not.toContain("secret-metadata");
  });
});
