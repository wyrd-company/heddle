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
import {
  sampleHandoffTemplate,
  sampleTemplateAuthority,
} from "./session-bootstrap.test-support.js";

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
  task: { id: 1, title: "Prepare inventory" },
  taskId: 1,
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
  handoffTemplate: sampleHandoffTemplate,
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

const registerWorkflowMcpProviderSession = async (): Promise<void> => undefined;
const workflowMcpEndpoint = "http://127.0.0.1:4774/mcp";

const initialState = (): InstanceState => ({
  correlationTokens: {},
  flowcraftContext: { awaitingNodeIds: ["prepare"] },
  handoffs: [],
  todoState: null,
});

const memoryStore = (state: InstanceState = initialState()) => {
  let record: InstanceRecord = {
    instanceId: input.instanceId,
    state,
    version: 1,
  };
  return {
    get record() {
      return record;
    },
    store: {
      getInstance: () => record,
      listInstances: () => [record],
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
        templateAuthority: sampleTemplateAuthority,
        resolveWorkflowMcpStageContract: resolveAwaitingStage,
        workflowMcpEndpoint,
        t3: { registerWorkflowMcpProviderSession, dispatch },
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
      templateAuthority: sampleTemplateAuthority,
      resolveWorkflowMcpStageContract: async () => ({
        ...workflowMcp,
        stage: "next",
        todoTemplate: "sample-next",
      }),
      workflowMcpEndpoint,
      t3: { registerWorkflowMcpProviderSession, dispatch },
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

  it("excludes prior lists without a canonical stored handoff contract", async () => {
    const list = (sessionKey: string) => ({
      items: [{ checked: false, id: "orient", text: "Orient on the sample" }],
      sessionKey,
      stage: "prepare",
      template: "sample-prepare",
    });
    const document = (correlationToken: string, stage = "prepare") =>
      JSON.stringify({
        correlationToken,
        format: "heddle.stage-handoff",
        stage: { name: stage },
        taskContract: { title: "Prepare inventory" },
        version: 1,
      });
    const memory = memoryStore({
      ...initialState(),
      handoffs: [
        {
          correlationToken: "missing-contract-token",
          handoff: document("missing-contract-token"),
          kind: "stage-handoff",
          sessionKey: "missing-contract",
        },
        {
          correlationToken: "invalid-document-token",
          handoff: "not-json",
          kind: "stage-handoff",
          sessionKey: "invalid-document",
          workflowMcp,
        },
        {
          correlationToken: "mismatched-stage-token",
          handoff: document("mismatched-stage-token", "inspect"),
          kind: "stage-handoff",
          sessionKey: "mismatched-stage",
          workflowMcp,
        },
        {
          correlationToken: "stored-token",
          handoff: document("document-token"),
          kind: "stage-handoff",
          sessionKey: "mismatched-token",
          workflowMcp,
        },
      ],
      todoState: {
        format: "heddle.todo-state",
        lists: [
          list("missing-contract"),
          list("invalid-document"),
          list("mismatched-stage"),
          list("mismatched-token"),
        ],
        version: 1,
      },
    });

    const result = await bootstrapStageSession(input, {
      persistence: memory.store,
      instantiateTodoList,
      templateAuthority: sampleTemplateAuthority,
      resolveWorkflowMcpStageContract: async () => workflowMcp,
      workflowMcpEndpoint,
      t3: {
        registerWorkflowMcpProviderSession,
        dispatch: async () => ({ sequence: 1 }),
      },
      ensureWorktree: async ({ branch }) => ({
        branch,
        created: false,
        path: "/workspaces/worktrees/sample-repository/task-prepare",
      }),
      mintCorrelationToken: () => "correlation-token",
      nextId: () => globalThis.crypto.randomUUID(),
    });
    const handoff = JSON.parse(result.handoff) as { todoList: TodoState };

    expect(handoff.todoList.lists.map(({ sessionKey }) => sessionKey)).toEqual([
      "prepare-1",
    ]);
    expect(
      (memory.record.state.todoState as TodoState).lists.map(
        ({ sessionKey }) => sessionKey,
      ),
    ).toEqual([
      "missing-contract",
      "invalid-document",
      "mismatched-stage",
      "mismatched-token",
      "prepare-1",
    ]);
  });
});
