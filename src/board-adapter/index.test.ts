// ---
// relationships:
//   implements: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EpicStatusConflictError,
  KanbanBoardAdapter,
  boardRecordIdentity,
  boardTaskMatchesRecord,
  type BoardTask,
  type KanbanCommandRunner,
} from "./index.js";
import { TaskProviderAliasError } from "../provider-alias.js";

const execute = promisify(execFile);

describe("KanbanBoardAdapter", () => {
  let boardDirectory: string;
  let commands: string[][];
  let adapter: KanbanBoardAdapter;

  const runKanban: KanbanCommandRunner = async (arguments_) => {
    commands.push(arguments_);
    const result = await execute("kanban-md", arguments_);
    return result.stdout;
  };

  const createTask = async (...arguments_: string[]): Promise<number> => {
    const output = await runKanban([
      "--dir",
      boardDirectory,
      "create",
      ...arguments_,
      "--json",
    ]);
    return (JSON.parse(output) as { id: number }).id;
  };

  beforeEach(async () => {
    boardDirectory = await mkdtemp(join(tmpdir(), "board-adapter-test-"));
    commands = [];
    await mkdir(join(boardDirectory, "tasks"));
    await writeFile(
      join(boardDirectory, "config.yml"),
      `version: 11
board:
  name: Sample Collection
tasks_dir: tasks
statuses:
  - name: backlog
    show_duration: false
  - name: todo
  - name: in-progress
  - name: uat
  - name: done
    show_duration: false
  - name: archived
    show_duration: false
priorities:
  - low
  - medium
  - high
  - critical
defaults:
  status: backlog
  priority: medium
  class: standard
claim_timeout: 1h
classes:
  - name: expedite
    wip_limit: 1
    bypass_column_wip: true
  - name: fixed-date
  - name: standard
  - name: intangible
tui:
  title_lines: 2
  age_thresholds:
    - after: 0s
      color: "242"
next_id: 1
`,
    );
    commands = [];
    adapter = new KanbanBoardAdapter(boardDirectory, runKanban);
  });

  afterEach(async () => {
    await rm(boardDirectory, { recursive: true });
  });

  it("keeps repository-free record identities compatible and binds repository scope when present", () => {
    const legacyRecord = {
      body: "Record the storage count.",
      kind: "finding" as const,
      lifecycle: "inventory-review",
      parent: 7,
      title: "Count storage crates",
    };
    const legacyIdentity = boardRecordIdentity({
      ...legacyRecord,
      operationKey: "inventory:count",
    });
    expect(legacyIdentity.recordDigest).toBe(
      "125e80387d80f6a0090b31af44440f4f1c99b0254278e6278810da8c11152529",
    );

    const scopedRecord = {
      ...legacyRecord,
      repos: ["sample-alpha", "sample-beta"],
    };
    const scopedIdentity = boardRecordIdentity({
      ...scopedRecord,
      operationKey: "inventory:count:scoped",
    });
    expect(scopedIdentity.recordDigest).not.toBe(legacyIdentity.recordDigest);
    const task: BoardTask = {
      blocked: false,
      dependencies: [],
      frontMatter: {},
      id: 8,
      lifecycle: scopedRecord.lifecycle,
      parent: scopedRecord.parent,
      priority: "medium",
      repos: scopedRecord.repos,
      status: "backlog",
      tags: [
        "type:finding",
        `heddle-operation:${scopedIdentity.operationDigest}`,
        `heddle-record:${scopedIdentity.recordDigest}`,
      ],
      title: scopedRecord.title,
    };
    expect(boardTaskMatchesRecord(task, scopedRecord, scopedIdentity)).toBe(
      true,
    );
    expect(
      boardTaskMatchesRecord(
        { ...task, repos: ["sample-alpha"] },
        scopedRecord,
        scopedIdentity,
      ),
    ).toBe(false);
  });

  it("reads parentage, dependencies, and both lifecycle representations", async () => {
    const collectionId = await createTask(
      "Seasonal collection",
      "--status",
      "in-progress",
      "--tags",
      "sample,lifecycle:collection-renewal",
    );
    const inventoryId = await createTask(
      "Count storage crates",
      "--parent",
      String(collectionId),
    );
    await runKanban([
      "--dir",
      boardDirectory,
      "edit",
      String(inventoryId),
      "--block",
      "Awaiting a storage-room key",
      "--json",
    ]);
    const displayId = await createTask(
      "Prepare display shelves",
      "--parent",
      String(collectionId),
      "--depends-on",
      String(inventoryId),
      "--tags",
      "sample,lifecycle:ignored-fallback",
    );

    const display = JSON.parse(
      await runKanban([
        "--dir",
        boardDirectory,
        "show",
        String(displayId),
        "--json",
      ]),
    ) as { file: string };
    const source = await readFile(display.file, "utf8");
    await writeFile(
      display.file,
      source.replace(
        "class: standard\n---",
        "class: standard\nlifecycle: exhibit-preparation\n---",
      ),
    );

    const tasks = await adapter.readBoard();

    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: collectionId,
          lifecycle: "collection-renewal",
        }),
        expect.objectContaining({
          blocked: true,
          id: inventoryId,
        }),
        expect.objectContaining({
          id: displayId,
          parent: collectionId,
          dependencies: [inventoryId],
          lifecycle: "exhibit-preparation",
        }),
      ]),
    );
  });

  it("reads typed repository scope while retaining raw front matter", async () => {
    const taskId = await createTask("Arrange sample items");
    const task = JSON.parse(
      await runKanban([
        "--dir",
        boardDirectory,
        "show",
        String(taskId),
        "--json",
      ]),
    ) as { file: string };
    const source = await readFile(task.file, "utf8");
    await writeFile(
      task.file,
      source.replace(
        "class: standard\n---",
        "class: standard\nproduct: sample-product\nrepos:\n  - sample-alpha\n  - sample-beta\n---",
      ),
    );

    const typedAdapter = new KanbanBoardAdapter(
      boardDirectory,
      async (arguments_) => {
        const output = await runKanban(arguments_);
        const value = JSON.parse(output) as Record<string, unknown>;
        value.repos = ["sample-alpha", "sample-beta"];
        return JSON.stringify(value);
      },
    );

    await expect(typedAdapter.readTask(taskId)).resolves.toMatchObject({
      frontMatter: {
        id: taskId,
        product: "sample-product",
        repos: ["sample-alpha", "sample-beta"],
        title: "Arrange sample items",
      },
      product: "sample-product",
      repos: ["sample-alpha", "sample-beta"],
    });
  });

  it("normalizes and preserves a stage provider-alias map through supported board mutations", async () => {
    const taskId = await createTask("Arrange sample items");
    const task = JSON.parse(
      await runKanban([
        "--dir",
        boardDirectory,
        "show",
        String(taskId),
        "--json",
      ]),
    ) as { file: string };
    const source = await readFile(task.file, "utf8");
    await writeFile(
      task.file,
      source.replace(
        "class: standard\n---",
        "class: standard\nprovider-alias:\n  implement: specialist\n---",
      ),
    );

    await adapter.mirrorTaskStatus(taskId, "in-progress");
    await runKanban([
      "--dir",
      boardDirectory,
      "edit",
      String(taskId),
      "--block",
      "Waiting for a sample fixture",
      "--json",
    ]);

    await expect(adapter.readTask(taskId)).resolves.toMatchObject({
      blocked: true,
      frontMatter: { "provider-alias": { implement: "specialist" } },
      providerAlias: { implement: "specialist" },
      status: "in-progress",
    });
  });

  it.each([
    "provider-alias: specialist",
    "provider-alias: ''",
    "provider-alias: 17",
    "provider-alias: [sample]",
    "provider-alias:",
  ])(
    "rejects a non-map task provider-alias shape with a named cause: %s",
    async (declaration) => {
      const taskId = await createTask("Arrange sample items");
      const task = JSON.parse(
        await runKanban([
          "--dir",
          boardDirectory,
          "show",
          String(taskId),
          "--json",
        ]),
      ) as { file: string };
      const source = await readFile(task.file, "utf8");
      await writeFile(
        task.file,
        source.replace(
          "class: standard\n---",
          `class: standard\n${declaration}\n---`,
        ),
      );

      await expect(adapter.readTask(taskId)).rejects.toMatchObject({
        message: expect.stringMatching(
          new RegExp(
            `provider-alias-not-allowed: task ${taskId} provider-alias must be a stage-to-alias mapping`,
          ),
        ),
        name: "TaskProviderAliasError",
        reason: "provider-alias-not-allowed",
        taskId,
      } satisfies Partial<TaskProviderAliasError>);
    },
  );

  it.each([
    ["empty", "provider-alias:\n  implement: ''"],
    ["null", "provider-alias:\n  implement:"],
    ["non-string", "provider-alias:\n  implement: 17"],
    ["sequence", "provider-alias:\n  implement: [sample]"],
    ["mapping", "provider-alias:\n  implement: { sample: value }"],
    ["malformed", "provider-alias:\n  implement: Not-Valid"],
    ["overlong", `provider-alias:\n  implement: ${"a".repeat(65)}`],
  ])(
    "rejects a present %s alias map value without fallback",
    async (_, declaration) => {
      const taskId = await createTask("Arrange sample items");
      const task = JSON.parse(
        await runKanban([
          "--dir",
          boardDirectory,
          "show",
          String(taskId),
          "--json",
        ]),
      ) as { file: string };
      const source = await readFile(task.file, "utf8");
      await writeFile(
        task.file,
        source.replace(
          "class: standard\n---",
          `class: standard\n${declaration}\n---`,
        ),
      );

      await expect(adapter.readTask(taskId)).rejects.toMatchObject({
        message: expect.stringContaining(
          `provider-alias-not-allowed: task ${taskId} provider-alias key "implement"`,
        ),
        name: "TaskProviderAliasError",
        reason: "provider-alias-not-allowed",
        taskId,
      } satisfies Partial<TaskProviderAliasError>);
    },
  );

  it.each([
    ["empty", []],
    ["duplicate", ["sample-alpha", "sample-alpha"]],
    ["scalar", "sample-alpha"],
    ["invalid identifier", ["../outside"]],
  ])("rejects invalid typed repository scope: %s", async (_, repos) => {
    const taskId = await createTask("Arrange sample items");
    const typedAdapter = new KanbanBoardAdapter(
      boardDirectory,
      async (arguments_) => {
        const output = await runKanban(arguments_);
        const value = JSON.parse(output) as Record<string, unknown>;
        value.repos = repos;
        return JSON.stringify(value);
      },
    );

    await expect(typedAdapter.readTask(taskId)).rejects.toThrow(
      "kanban-md returned an invalid task repository scope",
    );
  });

  it("reads every configured board column in board order", async () => {
    await expect(adapter.readBoardStatuses()).resolves.toEqual([
      "backlog",
      "todo",
      "in-progress",
      "uat",
      "done",
    ]);
  });

  it("mirrors standalone status while preserving the epic status boundary", async () => {
    const collectionId = await createTask(
      "Seasonal collection",
      "--tags",
      "type:epic",
    );
    const standaloneId = await createTask("Repair reading-room lamp");
    const childId = await createTask(
      "Label storage crates",
      "--parent",
      String(collectionId),
    );

    await adapter.mirrorTaskStatus(standaloneId, "in-progress");
    await adapter.mirrorTaskStatus(childId, "done");

    await expect(adapter.readTask(standaloneId)).resolves.toMatchObject({
      status: "in-progress",
    });
    await expect(adapter.readTask(childId)).resolves.toMatchObject({
      status: "done",
    });
    await expect(
      adapter.mirrorTaskStatus(collectionId, "done"),
    ).rejects.toThrow("is an epic task");
  });

  it("limits epic transitions to uat and done", async () => {
    const collectionId = await createTask(
      "Seasonal collection",
      "--tags",
      "type:epic",
    );
    const standaloneId = await createTask("Repair reading-room lamp");
    const childId = await createTask(
      "Label storage crates",
      "--parent",
      String(collectionId),
    );

    await adapter.transitionEpicStatus(collectionId, "uat");

    await expect(adapter.readTask(collectionId)).resolves.toMatchObject({
      status: "uat",
    });
    await expect(
      adapter.transitionEpicStatus(collectionId, "todo" as "uat"),
    ).rejects.toThrow("epic status transition is not allowed");
    await expect(adapter.transitionEpicStatus(childId, "done")).rejects.toThrow(
      "is not an epic task",
    );
    commands = [];
    await expect(
      adapter.transitionEpicStatus(standaloneId, "done"),
    ).rejects.toThrow("is not an epic task");
    expect(commands).not.toContainEqual(
      expect.arrayContaining(["edit", String(standaloneId)]),
    );
  });

  it.each([
    ["backlog", true, "in-progress"],
    ["todo", true, "in-progress"],
    ["in-progress", false, "todo"],
    ["uat", false, "todo"],
  ] as const)(
    "moves an epic from %s when inProgress is %s",
    async (status, inProgress, expectedStatus) => {
      const collectionId = await createTask(
        "Seasonal collection",
        "--status",
        status,
        "--tags",
        "type:epic",
      );

      await adapter.setEpicInProgress(collectionId, inProgress);

      await expect(adapter.readTask(collectionId)).resolves.toMatchObject({
        status: expectedStatus,
      });
    },
  );

  it.each([
    ["uat", true],
    ["done", true],
    ["done", false],
    ["archived", true],
  ] as const)(
    "rejects status %s with inProgress=%s without a board write",
    async (status, inProgress) => {
      const collectionId = await createTask(
        "Seasonal collection",
        "--status",
        status,
        "--tags",
        "type:epic",
      );
      commands = [];

      await expect(
        adapter.setEpicInProgress(collectionId, inProgress),
      ).rejects.toBeInstanceOf(EpicStatusConflictError);
      expect(commands).not.toContainEqual(
        expect.arrayContaining(["edit", String(collectionId)]),
      );
      await expect(adapter.readTask(collectionId)).resolves.toMatchObject({
        status,
      });
    },
  );

  it("moves only an epic in and out of in-progress", async () => {
    const collectionId = await createTask(
      "Seasonal collection",
      "--tags",
      "type:epic",
    );
    const childId = await createTask(
      "Label storage crates",
      "--parent",
      String(collectionId),
    );
    const standaloneId = await createTask("Repair reading-room lamp");
    commands = [];

    commands = [];
    await expect(adapter.setEpicInProgress(childId, true)).rejects.toThrow(
      "is not an epic task",
    );
    await expect(adapter.setEpicInProgress(standaloneId, true)).rejects.toThrow(
      "is not an epic task",
    );
    expect(commands).not.toContainEqual(
      expect.arrayContaining(["edit", String(childId)]),
    );
    expect(commands).not.toContainEqual(
      expect.arrayContaining(["edit", String(standaloneId)]),
    );
  });

  it("creates follow-ups and findings that a later board read sees", async () => {
    const collectionId = await createTask(
      "Seasonal collection",
      "--tags",
      "type:epic",
    );

    const followUp = await adapter.createRecord({
      kind: "follow-up",
      title: "Replace worn shelf labels",
      body: "Use labels that remain readable under gallery lighting.",
      parent: collectionId,
      lifecycle: "small-maintenance",
      operationKey: "stage-one:create-follow-up:labels",
      status: "backlog",
    });
    const finding = await adapter.createRecord({
      kind: "finding",
      title: "Document crate has a loose hinge",
      body: "The rear hinge moves when the lid opens.",
      parent: collectionId,
      dependsOn: [followUp.task.id],
      lifecycle: "inspection-response",
      operationKey: "stage-one:create-finding:hinge",
      priority: "high",
      status: "backlog",
    });

    const tasks = await adapter.readBoard();
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: followUp.task.id,
          tags: expect.arrayContaining([
            "type:follow-up",
            "lifecycle:small-maintenance",
          ]),
        }),
        expect.objectContaining({
          id: finding.task.id,
          dependencies: [followUp.task.id],
          lifecycle: "inspection-response",
          tags: expect.arrayContaining(["type:finding"]),
        }),
      ]),
    );
    expect(followUp.replayed).toBe(false);
    expect(finding.replayed).toBe(false);
  });

  it("authors repository scope through the typed kanban create field", async () => {
    const collectionId = await createTask(
      "Seasonal collection",
      "--tags",
      "type:epic",
    );
    const typedCommands: string[][] = [];
    const typedAdapter = new KanbanBoardAdapter(
      boardDirectory,
      async (arguments_) => {
        typedCommands.push(arguments_);
        const reposIndex = arguments_.indexOf("--repos");
        if (reposIndex === -1) return runKanban(arguments_);

        const repositoryValue = arguments_[reposIndex + 1]!;
        const forwarded = arguments_.filter(
          (_, index) => index !== reposIndex && index !== reposIndex + 1,
        );
        const output = await runKanban(forwarded);
        const value = JSON.parse(output) as Record<string, unknown> & {
          file: string;
        };
        const repos = repositoryValue.split(",");
        value.repos = repos;
        const source = await readFile(value.file, "utf8");
        await writeFile(
          value.file,
          source.replace(
            "class: standard\n---",
            `class: standard\nrepos:\n${repos.map((repo) => `  - ${repo}`).join("\n")}\n---`,
          ),
        );
        return JSON.stringify(value);
      },
    );

    const result = await typedAdapter.createRecord({
      body: "Record the selected storage locations.",
      kind: "finding",
      lifecycle: "inspection-response",
      operationKey: "stage-one:create-finding:locations",
      parent: collectionId,
      repos: ["sample-alpha", "sample-beta"],
      status: "backlog",
      title: "Record storage locations",
    });

    expect(result.task.repos).toEqual(["sample-alpha", "sample-beta"]);
    expect(typedCommands).toContainEqual(
      expect.arrayContaining([
        "create",
        "Record storage locations",
        "--repos",
        "sample-alpha,sample-beta",
      ]),
    );
  });

  it.each([
    ["empty", []],
    ["duplicate", ["sample-alpha", "sample-alpha"]],
    ["invalid identifier", ["../outside"]],
  ])(
    "rejects invalid repository scope before board authoring: %s",
    async (_, repos) => {
      commands = [];
      await expect(
        adapter.createRecord({
          body: "Record the selected storage locations.",
          kind: "finding",
          lifecycle: "inspection-response",
          operationKey: "stage-one:create-finding:invalid-locations",
          parent: 1,
          repos,
          status: "backlog",
          title: "Record storage locations",
        }),
      ).rejects.toThrow("invalid task repository scope");
      expect(commands).toEqual([]);
    },
  );

  it("replays one board-write occurrence without creating another task", async () => {
    const collectionId = await createTask(
      "Seasonal collection",
      "--tags",
      "type:epic",
    );
    const record = {
      kind: "follow-up" as const,
      title: "Replace worn shelf labels",
      body: "Use labels that remain readable under gallery lighting.",
      parent: collectionId,
      lifecycle: "small-maintenance",
      operationKey: "stage-one:create-follow-up:labels",
      status: "backlog",
    };

    const [first, replay] = await Promise.all([
      adapter.createRecord(record),
      adapter.createRecord(record),
    ]);

    expect(first.task.id).toBe(replay.task.id);
    expect([first.replayed, replay.replayed].sort()).toEqual([false, true]);
    expect(
      (await adapter.readBoard()).filter(
        ({ parent }) => parent === collectionId,
      ),
    ).toHaveLength(1);
  });

  it("appends one task activity for a replayed operation key", async () => {
    const taskId = await createTask("Record a sample decision");

    const results = await Promise.all([
      adapter.appendTaskActivity(
        taskId,
        "sample-escalation:task",
        "**SAMPLE DECISION**\n\n- Choice: Route B\n---",
      ),
      adapter.appendTaskActivity(
        taskId,
        "sample-escalation:task",
        "**SAMPLE DECISION**\n\n- Choice: Route B\n---",
      ),
    ]);

    expect(results.sort()).toEqual([false, true]);
    const task = JSON.parse(
      await runKanban([
        "--dir",
        boardDirectory,
        "show",
        String(taskId),
        "--json",
      ]),
    ) as { file: string };
    const source = await readFile(task.file, "utf8");
    expect(source.match(/\*\*SAMPLE DECISION\*\*/g)).toHaveLength(1);
    expect(source.match(/<!-- heddle-activity:/g)).toHaveLength(1);
  });

  it("rejects changed input for an existing board-write occurrence", async () => {
    const collectionId = await createTask(
      "Seasonal collection",
      "--tags",
      "type:epic",
    );
    const record = {
      kind: "finding" as const,
      title: "Document crate has a loose hinge",
      body: "The rear hinge moves when the lid opens.",
      parent: collectionId,
      lifecycle: "inspection-response",
      operationKey: "stage-one:create-finding:hinge",
      status: "backlog",
    };
    await adapter.createRecord(record);

    await expect(
      adapter.createRecord({ ...record, title: "Changed title" }),
    ).rejects.toThrow("does not match its existing board task");
    expect(
      (await adapter.readBoard()).filter(
        ({ parent }) => parent === collectionId,
      ),
    ).toHaveLength(1);
  });

  it("rejects record parent and dependency authority outside one epic", async () => {
    const collectionId = await createTask(
      "Seasonal collection",
      "--tags",
      "type:epic",
    );
    const otherCollectionId = await createTask(
      "Other collection",
      "--tags",
      "type:epic",
    );
    const foreignDependencyId = await createTask(
      "Inspect another sample",
      "--parent",
      String(otherCollectionId),
    );
    const record = {
      body: "Use a separate fixture.",
      kind: "follow-up" as const,
      lifecycle: "small-maintenance",
      operationKey: "stage-one:create-follow-up:separate",
      status: "backlog",
      title: "Check another sample",
    };

    await expect(
      adapter.createRecord({ ...record, parent: foreignDependencyId }),
    ).rejects.toThrow(
      `board record parent ${foreignDependencyId} is not an epic`,
    );
    await expect(
      adapter.createRecord({
        ...record,
        dependsOn: [foreignDependencyId],
        operationKey: "stage-one:create-follow-up:foreign-dependency",
        parent: collectionId,
      }),
    ).rejects.toThrow(
      `board record dependency ${foreignDependencyId} is not a child of epic ${collectionId}`,
    );
    expect(
      (await adapter.readBoard()).filter(
        ({ parent }) => parent === collectionId,
      ),
    ).toHaveLength(0);
  });
});
