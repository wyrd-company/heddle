// ---
// relationships:
//   verifies: heddle
// ---

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SqlitePersistence,
  type InstanceRecord,
  type InstanceState,
} from "../persistence/index.js";
import { isTodoState, scopedTodoItems, todoSubtreeIds } from "../todo/index.js";
import {
  assignmentForChild,
  claimTodoAssignment,
  mutateTodoAssignment,
  type DelegationStateStore,
} from "./delegation-state.js";
import { stopTodoAssignmentTree } from "./delegation-teardown.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const state = (): InstanceState => ({
  correlationTokens: { parent: "parent-token" },
  flowcraftContext: null,
  handoffs: [],
  todoState: {
    format: "heddle.todo-state",
    lists: [
      {
        assignments: [],
        items: [
          { checked: false, id: "root", text: "Root" },
          { checked: false, id: "child", parentId: "root", text: "Child" },
          {
            checked: false,
            id: "grandchild",
            parentId: "child",
            text: "Grandchild",
          },
          { checked: false, id: "other", text: "Other" },
        ],
        sessionKey: "parent",
        stage: "implement",
        template: "sample-stage",
      },
    ],
    version: 1,
  },
});

class MemoryStore implements DelegationStateStore {
  record: InstanceRecord = {
    instanceId: "instance",
    state: state(),
    version: 1,
  };
  loseFirstClaim = false;

  compareAndSwapInstance(
    _instanceId: string,
    expectedVersion: number,
    next: InstanceState,
  ) {
    if (this.loseFirstClaim) {
      this.loseFirstClaim = false;
      this.record = {
        ...this.record,
        state: { ...this.record.state, handoffs: ["concurrent"] },
        version: this.record.version + 1,
      };
      return undefined;
    }
    if (expectedVersion !== this.record.version) return undefined;
    this.record = {
      ...this.record,
      state: next,
      version: this.record.version + 1,
    };
    return this.record;
  }

  getInstance(instanceId: string) {
    return instanceId === this.record.instanceId ? this.record : undefined;
  }

  listInstances() {
    return [this.record];
  }
}

const claim = (
  store: MemoryStore,
  overrides: Partial<Parameters<typeof claimTodoAssignment>[1]> = {},
) =>
  claimTodoAssignment(store, {
    bootstrap: {
      createCommandId: "create-child",
      createdAt: new Date(0).toISOString(),
      messageId: "message-child",
      turnCommandId: "turn-child",
    },
    correlationToken: "child-token",
    depth: 1,
    instanceId: "instance",
    listSessionKey: "parent",
    model: "sample-model",
    operationId: "spawn-one",
    parentSessionKey: "parent",
    parentThreadId: "parent-thread",
    provider: "sample-provider",
    rootItemId: "root",
    sessionKey: "child-session",
    stage: "implement",
    threadId: "child-thread",
    ...overrides,
  });

describe("todo subtree assignments", () => {
  it("resolves a durable acyclic subtree and rejects missing or cyclic ancestry", () => {
    const store = new MemoryStore();
    const list = (store.record.state.todoState as { lists: never[] })
      .lists[0] as never;
    expect([...todoSubtreeIds(list, "root")]).toEqual([
      "root",
      "child",
      "grandchild",
    ]);
    expect(scopedTodoItems(list, "child").map(({ id }) => id)).toEqual([
      "child",
      "grandchild",
    ]);
    expect(() => todoSubtreeIds(list, "absent")).toThrow(/does not exist/);

    const cyclic = JSON.parse(JSON.stringify(store.record.state.todoState)) as {
      lists: Array<{ items: Array<Record<string, unknown>> }>;
    };
    cyclic.lists[0]!.items[0]!["parentId"] = "grandchild";
    expect(isTodoState(cyclic as never)).toBe(false);
  });

  it("atomically publishes the assignment and correlation token across a CAS retry", () => {
    const store = new MemoryStore();
    store.loseFirstClaim = true;

    expect(claim(store)).toMatchObject({
      correlationToken: "child-token",
      rootItemId: "root",
      sessionKey: "child-session",
      status: "active",
    });
    expect(store.record.state.correlationTokens["child-session"]).toBe(
      "child-token",
    );
    expect(store.record.state.handoffs).toEqual(["concurrent"]);
    expect(
      assignmentForChild(store.record, "child-session").assignment,
    ).toMatchObject({
      operationId: "spawn-one",
      threadId: "child-thread",
    });
  });

  it("refuses every active assignment whose subtree overlaps", () => {
    const store = new MemoryStore();
    claim(store);

    expect(() =>
      claim(store, {
        correlationToken: "second-token",
        operationId: "spawn-two",
        rootItemId: "child",
        sessionKey: "second-session",
        threadId: "second-thread",
      }),
    ).toThrow(/already assigned/);
    expect(() =>
      claim(store, {
        correlationToken: "third-token",
        operationId: "spawn-three",
        rootItemId: "other",
        sessionKey: "third-session",
        threadId: "third-thread",
      }),
    ).not.toThrow();
  });

  it("allows the owning child to delegate a proper descendant", () => {
    const store = new MemoryStore();
    claim(store);

    expect(
      claim(store, {
        correlationToken: "nested-token",
        depth: 2,
        operationId: "spawn-nested",
        parentSessionKey: "child-session",
        parentThreadId: "child-thread",
        rootItemId: "child",
        sessionKey: "nested-session",
        threadId: "nested-thread",
      }),
    ).toMatchObject({
      parentSessionKey: "child-session",
      rootItemId: "child",
      status: "active",
    });
  });

  it("atomically stops an assignment and every active descendant with replay after reload", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "subagent-stop-tree-"));
    temporaryDirectories.push(stateDirectory);
    let persistence = new SqlitePersistence({ stateDirectory });
    persistence.createInstance("instance", state());
    claimTodoAssignment(persistence, {
      ...claimInput(),
    });
    claimTodoAssignment(persistence, {
      ...claimInput(),
      bootstrap: {
        createCommandId: "create-nested",
        createdAt: new Date(0).toISOString(),
        messageId: "message-nested",
        turnCommandId: "turn-nested",
      },
      correlationToken: "nested-token",
      depth: 2,
      operationId: "spawn-nested",
      parentSessionKey: "child-session",
      parentThreadId: "child-thread",
      rootItemId: "child",
      sessionKey: "nested-session",
      threadId: "nested-thread",
    });
    const notice = {
      commandId: "stop-command",
      createdAt: new Date(1).toISOString(),
      message: "Child stopped with phase failed.",
      messageId: "stop-message",
      phase: "failed" as const,
      status: "issued" as const,
    };
    expect(() =>
      mutateTodoAssignment(
        persistence,
        "instance",
        "child-session",
        (assignment) => ({
          ...assignment,
          status: "stopped",
          stopNotification: notice,
        }),
      ),
    ).toThrow(/mutation is invalid/);
    const versionBeforeStop = persistence.getInstance("instance")!.version;

    expect(
      stopTodoAssignmentTree(persistence, "instance", "child-session", notice),
    ).toMatchObject({
      assignment: { stopNotification: notice },
      stoppedSessionKeys: ["child-session", "nested-session"],
    });
    expect(persistence.getInstance("instance")!.version).toBe(
      versionBeforeStop + 1,
    );
    persistence.close();
    persistence = new SqlitePersistence({ stateDirectory });
    const reloaded = persistence.getInstance("instance")!;
    expect(
      assignmentForChild(reloaded, "nested-session").assignment,
    ).toMatchObject({
      ancestorStop: {
        ancestorSessionKey: "child-session",
        createdAt: notice.createdAt,
      },
      status: "stopped",
    });
    const reloadedVersion = reloaded.version;
    expect(
      stopTodoAssignmentTree(persistence, "instance", "child-session", {
        ...notice,
        message: "Different replay payload",
      }),
    ).toMatchObject({
      assignment: { stopNotification: notice },
      stoppedSessionKeys: ["child-session", "nested-session"],
    });
    expect(persistence.getInstance("instance")!.version).toBe(reloadedVersion);
    persistence.close();
  });

  it("rejects a reused operation when its requested contract changes", () => {
    const store = new MemoryStore();
    claim(store);

    expect(() => claim(store, { model: "different-model" })).toThrow(
      /does not match/,
    );
  });
});

const claimInput = (): Parameters<typeof claimTodoAssignment>[1] => ({
  bootstrap: {
    createCommandId: "create-child",
    createdAt: new Date(0).toISOString(),
    messageId: "message-child",
    turnCommandId: "turn-child",
  },
  correlationToken: "child-token",
  depth: 1,
  instanceId: "instance",
  listSessionKey: "parent",
  model: "sample-model",
  operationId: "spawn-one",
  parentSessionKey: "parent",
  parentThreadId: "parent-thread",
  provider: "sample-provider",
  rootItemId: "root",
  sessionKey: "child-session",
  stage: "implement",
  threadId: "child-thread",
});
