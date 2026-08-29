// ---
// relationships:
//   validates: heddle
// ---

import {
  createConsoleAttention,
  createConsoleServer,
} from "../../dist/console/index.js";

const initialTasks = [
  {
    blocked: false,
    dependencies: [],
    id: 40,
    priority: "medium",
    status: "in-progress",
    tags: ["type:epic"],
    title: "Community room refresh",
  },
  {
    blocked: false,
    dependencies: [],
    id: 41,
    parent: 40,
    priority: "medium",
    status: "done",
    tags: [],
    title:
      "Measure the storage wall and record every available dimension before selecting fixtures",
  },
  {
    blocked: false,
    dependencies: [],
    id: 42,
    parent: 40,
    priority: "high",
    status: "in-progress",
    tags: [],
    title:
      "Catalogue the retained supplies and label each container with its intended destination",
  },
  {
    blocked: true,
    dependencies: [41, 42],
    id: 43,
    parent: 40,
    priority: "high",
    status: "todo",
    tags: [],
    title: "Arrange the refreshed room for the next community meeting",
  },
];

const lifecycleEvents = [
  {
    executionId: "execution-a",
    payload: { input: { source: "fixture" }, nodeId: "measure" },
    sequence: 1,
    type: "node:start",
  },
  {
    executionId: "execution-a",
    payload: { nodeId: "measure", result: { output: { recorded: true } } },
    sequence: 2,
    type: "node:finish",
  },
  {
    executionId: "execution-a",
    payload: { input: { pass: 1 }, nodeId: "arrange" },
    sequence: 3,
    type: "node:start",
  },
  {
    executionId: "execution-a",
    payload: { nodeId: "arrange", result: { output: { pass: 1 } } },
    sequence: 4,
    type: "node:finish",
  },
  {
    executionId: "execution-b",
    payload: { input: { pass: 2 }, nodeId: "arrange" },
    sequence: 5,
    type: "node:start",
  },
];

const lifecycleBlueprint = {
  blobHash: "a".repeat(40),
  edges: [{ source: "measure", target: "arrange" }],
  id: "room-refresh",
  nodes: [
    { id: "measure", uses: "wait" },
    { id: "arrange", uses: "wait" },
  ],
  path: "blueprints/room-refresh.json",
};

const question = ({ header, id, prompt }) => ({
  ...(header === undefined ? {} : { header }),
  id,
  multiSelect: false,
  options: [
    {
      description: "Use the smaller available arrangement.",
      label: "Compact",
      value: "compact",
    },
    {
      description: "Use the larger available arrangement.",
      label: "Expanded",
      value: "expanded",
    },
  ],
  prompt,
});

const attentionCatalog = () => [
  createConsoleAttention({
    actions: [
      {
        actionId: "answer",
        contract: {
          escalationId: "choice-a",
          instanceId: "instance-43",
          kind: "escalation.answer",
          ownerSessionKey: "session-a",
        },
        input: {
          kind: "questions",
          questions: [
            question({
              header: "Arrangement",
              id: "layout",
              prompt: "Which arrangement should be used?",
            }),
          ],
        },
        label: "Answer",
      },
    ],
    attentionId: "choice-a",
    instanceId: "instance-43",
    kind: "escalation",
    message: "An arrangement choice is required.",
    scope: "task:43",
    taskId: 43,
  }),
  createConsoleAttention({
    actions: [
      {
        actionId: "accept",
        contract: {
          decision: "accept",
          instanceId: "instance-43",
          kind: "t3.approval.respond",
          requestId: "approval-a",
          sessionKey: "session-a",
          threadId: "thread-a",
        },
        input: { kind: "none" },
        label: "Accept",
      },
      {
        actionId: "reject",
        contract: {
          decision: "reject",
          instanceId: "instance-43",
          kind: "t3.approval.respond",
          requestId: "approval-a",
          sessionKey: "session-a",
          threadId: "thread-a",
        },
        input: { kind: "none" },
        label: "Reject",
      },
    ],
    attentionId: "approval-a",
    instanceId: "instance-43",
    kind: "approval",
    message: "A proposed arrangement requires approval.",
    scope: "task:43",
    taskId: 43,
  }),
  createConsoleAttention({
    actions: [
      {
        actionId: "respond",
        contract: {
          instanceId: "instance-43",
          kind: "t3.user-input.respond",
          requestId: "input-a",
          sessionKey: "session-a",
          threadId: "thread-a",
        },
        input: {
          kind: "questions",
          questions: [
            question({
              id: "placement",
              prompt: "Which placement should be used?",
            }),
          ],
        },
        label: "Respond",
      },
    ],
    attentionId: "input-a",
    instanceId: "instance-43",
    kind: "user-input",
    message: "A placement response is required.",
    scope: "task:43",
    taskId: 43,
  }),
  createConsoleAttention({
    actions: [],
    attentionId: "stale-a",
    instanceId: "instance-42",
    kind: "stale-work",
    message: "One catalogue pass has not changed recently.",
    scope: "task:42",
    taskId: 42,
  }),
  createConsoleAttention({
    actions: [],
    attentionId: "uat-a",
    instanceId: "instance-43",
    kind: "uat",
    message: "The room refresh is ready for user acceptance.",
    scope: "task:43",
    taskId: 43,
  }),
];

const clone = (value) => JSON.parse(JSON.stringify(value));

export const createConsoleQualificationFixture = () => {
  let tasks = clone(initialTasks);
  let resolvedAttention = new Set();
  let lifecycleTrace = [];
  let actions = [];
  let boardWrites = [];

  const state = {
    async listAttention() {
      return attentionCatalog().filter(
        ({ attentionId }) => !resolvedAttention.has(attentionId),
      );
    },
    async listEvents() {
      return [];
    },
    async listInstances() {
      return [
        {
          instanceId: "instance-42",
          stageEnteredAt: 17_999_400_000,
          stageId: "catalogue",
          taskId: 42,
        },
        {
          instanceId: "instance-43",
          stageEnteredAt: 17_999_700_000,
          stageId: "arrange",
          taskId: 43,
        },
      ];
    },
    async readLifecycle({ afterSequence, taskId }) {
      if (taskId !== 43) throw new Error("fixture lifecycle task is unknown");
      lifecycleTrace.push(afterSequence);
      const tails = new Map([
        [0, lifecycleEvents.slice(0, 3)],
        [3, lifecycleEvents.slice(3, 4)],
        [4, lifecycleEvents.slice(4, 5)],
        [5, []],
      ]);
      const events = tails.get(afterSequence);
      if (events === undefined)
        throw new Error("fixture lifecycle cursor is unknown");
      return {
        blueprint: lifecycleBlueprint,
        currentStageIds: ["arrange"],
        events,
        instanceId: "instance-43",
        nextSequence: events.at(-1)?.sequence ?? 5,
        status: "awaiting",
        taskId,
      };
    },
  };

  const board = {
    async readBoard() {
      return clone(tasks);
    },
    async readBoardStatuses() {
      return ["todo", "in-progress", "done"];
    },
    async setEpicInProgress(taskId, inProgress) {
      boardWrites.push({ inProgress, taskId });
      const task = tasks.find(({ id }) => id === taskId);
      if (task?.parent !== undefined || !task?.tags.includes("type:epic")) {
        throw new Error("fixture board write is not an epic");
      }
      task.status = inProgress ? "in-progress" : "todo";
    },
  };

  const actionPort = {
    async execute(input) {
      actions.push(clone(input));
      resolvedAttention.add(input.attention.attentionId);
    },
  };

  const server = createConsoleServer({
    actions: actionPort,
    board,
    now: () => 18_000_000_000,
    state,
  });

  return {
    actions: () => clone(actions),
    boardWrites: () => clone(boardWrites),
    lifecycleTrace: () => clone(lifecycleTrace),
    reset() {
      tasks = clone(initialTasks);
      resolvedAttention = new Set();
      lifecycleTrace = [];
      actions = [];
      boardWrites = [];
    },
    server,
    stableAttentionIds: attentionCatalog().map(
      ({ attentionId }) => attentionId,
    ),
  };
};
