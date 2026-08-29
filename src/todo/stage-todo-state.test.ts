// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it, vi } from "vitest";

import type { InstanceRecord, InstanceState } from "../persistence/index.js";
import { ensureStageTodoList } from "./stage-todo-state.js";

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
});
