// ---
// relationships:
//   verifies: heddle
// ---

import { describe, expect, it, vi } from "vitest";

import type {
  BoardRecordWriteResult,
  BoardTask,
  CreateBoardRecord,
} from "../board-adapter/index.js";
import { deliveryBlueprintFixture } from "../engine/lifecycle-blueprint.test-support.js";
import { workflowMcpBoardTools } from "./board-tools.js";
import type {
  WorkflowMcpBoardAuthority,
  WorkflowMcpToolContext,
} from "./types.js";

const task = (id: number, options: Partial<BoardTask> = {}): BoardTask => ({
  blocked: false,
  dependencies: [],
  frontMatter: { id, title: `Sample ${id}` },
  id,
  priority: "medium",
  status: "in-progress",
  tags: [],
  title: `Sample ${id}`,
  ...options,
});

const context = (taskContext: unknown = { id: 12 }) =>
  ({
    binding: {
      instance: { instanceId: "task-12", state: {}, version: 1 },
      sessionKey: "task-12:review:1",
      taskContext,
    },
  }) as WorkflowMcpToolContext;

type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

const handlerFor = (
  authority: WorkflowMcpBoardAuthority,
  name: "create_finding" | "create_follow_up",
  binding = context(),
): ToolHandler => {
  let handler: ToolHandler | undefined;
  const server = {
    registerTool(
      registeredName: string,
      _definition: unknown,
      value: ToolHandler,
    ) {
      if (registeredName === name) handler = value;
    },
  };
  for (const contributor of workflowMcpBoardTools(authority)) {
    contributor.register(server as never, binding);
  }
  if (handler === undefined) throw new Error(`No handler for ${name}`);
  return handler;
};

const authority = (
  tasks: BoardTask[],
  write: BoardRecordWriteResult = {
    replayed: false,
    task: task(21, { parent: 10, status: "backlog" }),
  },
) => {
  const createRecord = vi.fn<
    (record: CreateBoardRecord) => Promise<BoardRecordWriteResult>
  >(async () => write);
  return {
    authority: {
      createRecord,
      readTask: async (taskId: number) => {
        const found = tasks.find(({ id }) => id === taskId);
        if (found === undefined) throw new Error(`Missing task ${taskId}`);
        return found;
      },
    },
    createRecord,
  };
};

const input = {
  body: "The sample needs another independent check.",
  dependsOn: [13],
  lifecycle: "sample-follow-up",
  operationId: "record-one",
  priority: "high",
  title: "Check another sample",
};

describe("workflow MCP board tools", () => {
  it("matches every board tool name declared by the shipped blueprints", () => {
    const contributors = workflowMcpBoardTools({} as WorkflowMcpBoardAuthority);
    const declared = new Set<string>();
    for (const kind of ["standard-delivery", "trivial"] as const) {
      for (const tool of deliveryBlueprintFixture(kind).nodes.flatMap(
        ({ tools }) => tools ?? [],
      )) {
        if (tool === "create_follow_up" || tool === "create_finding") {
          declared.add(tool);
        }
      }
    }

    expect(contributors.map(({ name }) => name).sort()).toEqual(
      [...declared].sort(),
    );
    expect([...declared].sort()).toEqual([
      "create_finding",
      "create_follow_up",
    ]);
  });

  it("creates one backlog sibling under the bound task epic", async () => {
    const fixture = authority([
      task(10, { tags: ["type:epic"] }),
      task(12, { parent: 10 }),
      task(13, { parent: 10 }),
    ]);

    await expect(
      handlerFor(fixture.authority, "create_follow_up")(input),
    ).resolves.toMatchObject({
      structuredContent: {
        id: 21,
        kind: "follow-up",
        parent: 10,
        replayed: false,
        status: "backlog",
      },
    });
    expect(fixture.createRecord).toHaveBeenCalledWith({
      body: input.body,
      dependsOn: [13],
      kind: "follow-up",
      lifecycle: input.lifecycle,
      operationKey: JSON.stringify([
        "task-12",
        "task-12:review:1",
        "follow-up",
        "record-one",
      ]),
      parent: 10,
      priority: "high",
      status: "backlog",
      title: input.title,
    });
  });

  it("rejects task context that does not match the bound instance", async () => {
    const fixture = authority([]);

    await expect(
      handlerFor(
        fixture.authority,
        "create_finding",
        context({ id: 99 }),
      )(input),
    ).rejects.toThrow("matching task context authority");
    expect(fixture.createRecord).not.toHaveBeenCalled();
  });

  it("rejects a board write from a task outside an epic", async () => {
    const fixture = authority([task(12)]);

    await expect(
      handlerFor(fixture.authority, "create_finding")(input),
    ).rejects.toThrow("is not a direct child of an epic");
    expect(fixture.createRecord).not.toHaveBeenCalled();
  });
});
