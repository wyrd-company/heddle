// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it, vi } from "vitest";

import type { InstanceRecord, InstanceState } from "../persistence/index.js";
import type { TodoState } from "../todo/index.js";
import {
  bootstrapStageSession,
  type SessionBootstrapDependencies,
  type SessionBootstrapInput,
} from "./session-bootstrap.js";

const input: SessionBootstrapInput = {
  handoff: {
    skillPointer: "skill://prepare",
    stage: { kind: "standard", name: "prepare", priorStageOutputs: [] },
    taskContract: { title: "Prepare inventory" },
  },
  instanceId: "instance-1",
  interactionMode: "default",
  modelSelection: { instanceId: "cursor", model: "default" },
  projectId: "project-1",
  providerContext: {
    cliVersion: "2026.08.11-e8db854",
    driver: "cursor",
    lifecycle: "independent",
  },
  runtimeMode: "auto",
  sessionKey: "prepare-1",
  title: "Prepare inventory",
  worktree: {
    baseRef: "main",
    branch: "task/prepare",
    repositoryName: "sample-repository",
    repositoryRoot: "/workspaces/sample-repository",
    worktreeName: "task-prepare",
  },
};

const workflowMcp = {
  blueprintBlobHash: "a".repeat(40),
  blueprintPath: "blueprints/sample-process.json",
  dispositions: [{ description: "Finish the preparation", name: "complete" }],
  stage: "prepare",
  todoTemplate: "sample-prepare",
  tools: ["advance", "get_task_context"],
};

const instantiateTodoList: NonNullable<
  SessionBootstrapDependencies["instantiateTodoList"]
> = async ({ sessionKey, stage, templateId }) => ({
  items: [{ checked: false, id: "orient", text: "Orient on the sample" }],
  sessionKey,
  stage,
  template: templateId,
});

const memoryStore = () => {
  let record: InstanceRecord = {
    instanceId: input.instanceId,
    state: {
      correlationTokens: {},
      flowcraftContext: { awaitingNodeIds: ["prepare"] },
      handoffs: [],
      todoState: null,
    },
    version: 1,
  };
  return {
    get record() {
      return record;
    },
    store: {
      getInstance: () => record,
      compareAndSwapInstance: (
        _id: string,
        version: number,
        nextState: InstanceState,
      ) => {
        if (version !== record.version) return undefined;
        record = { ...record, state: nextState, version: record.version + 1 };
        return record;
      },
    },
  };
};

describe("abandoned activation todo state", () => {
  it("retains but excludes an abandoned activation list from the next valid handoff", async () => {
    const memory = memoryStore();
    let advanced = false;
    const instantiateAcrossAdvance: typeof instantiateTodoList = async (
      instantiateInput,
    ) => {
      const current = memory.record;
      advanced =
        memory.store.compareAndSwapInstance(
          current.instanceId,
          current.version,
          {
            ...current.state,
            flowcraftContext: { awaitingNodeIds: ["next"] },
          },
        ) !== undefined;
      return instantiateTodoList(instantiateInput);
    };
    const resolveAwaitingStage: NonNullable<
      SessionBootstrapDependencies["resolveWorkflowMcpStageContract"]
    > = async (bootstrapInput, record) => {
      const context = record.state.flowcraftContext as {
        awaitingNodeIds: string[];
      };
      if (context.awaitingNodeIds[0] !== bootstrapInput.handoff.stage.name) {
        throw new Error(
          "Stage session bootstrap does not match the awaiting lifecycle stage",
        );
      }
      return workflowMcp;
    };
    const dispatch = vi.fn(async () => ({ sequence: 1 }));

    await expect(
      bootstrapStageSession(input, {
        persistence: memory.store,
        instantiateTodoList: instantiateAcrossAdvance,
        resolveWorkflowMcpStageContract: resolveAwaitingStage,
        t3: { dispatch },
        ensureWorktree: async ({ branch }) => ({
          branch,
          created: false,
          path: "/workspaces/worktrees/sample-repository/task-prepare",
        }),
        mintCorrelationToken: () => "correlation-token",
      }),
    ).rejects.toThrow("does not match the awaiting lifecycle stage");

    expect(advanced).toBe(true);
    expect(memory.record.state.flowcraftContext).toEqual({
      awaitingNodeIds: ["next"],
    });
    expect(memory.record.state.handoffs).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(memory.record.state.todoState).toMatchObject({
      lists: [{ sessionKey: "prepare-1", stage: "prepare" }],
    });

    const nextInput: SessionBootstrapInput = {
      ...input,
      handoff: {
        ...input.handoff,
        skillPointer: "skill://next",
        stage: { kind: "standard", name: "next", priorStageOutputs: [] },
      },
      sessionKey: "next-1",
    };
    const next = await bootstrapStageSession(nextInput, {
      persistence: memory.store,
      instantiateTodoList,
      resolveWorkflowMcpStageContract: async () => ({
        ...workflowMcp,
        stage: "next",
        todoTemplate: "sample-next",
      }),
      t3: { dispatch },
      ensureWorktree: async ({ branch }) => ({
        branch,
        created: false,
        path: "/workspaces/worktrees/sample-repository/task-next",
      }),
      mintCorrelationToken: () => "next-correlation-token",
      nextId: () => globalThis.crypto.randomUUID(),
    });
    const nextHandoff = JSON.parse(next.handoff) as { todoList: TodoState };

    expect(
      nextHandoff.todoList.lists.map(({ sessionKey }) => sessionKey),
    ).toEqual(["next-1"]);
    expect(
      (memory.record.state.todoState as TodoState).lists.map(
        ({ sessionKey }) => sessionKey,
      ),
    ).toEqual(["prepare-1", "next-1"]);
    expect(memory.record.state.handoffs).toMatchObject([
      { sessionKey: "next-1", workflowMcp: { stage: "next" } },
    ]);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
