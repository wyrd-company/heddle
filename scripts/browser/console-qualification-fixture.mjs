// ---
// relationships:
//   validates: heddle
// ---

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  CONSOLE_ATTENTION_KIND_LABELS,
  createConsoleAttention,
  createConsoleServer,
} from "../../dist/console/index.js";
import { BlueprintArtifactEditor } from "../../dist/engine/index.js";

const executeFile = promisify(execFile);

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

const lifecycleNodeIds = [
  "measure",
  "catalogue",
  "plan",
  "prepare",
  "arrange",
  "inspect",
  "refine",
  "finish",
];

const lifecycleEvents = Array.from({ length: 118 }, (_, index) => {
  const nodeId =
    lifecycleNodeIds[Math.floor(index / 2) % lifecycleNodeIds.length];
  const pass = Math.floor(index / (lifecycleNodeIds.length * 2)) + 1;
  const executionId = `execution-${pass}`;
  const sequence = index + 1;
  return index % 2 === 0
    ? {
        executionId,
        payload: {
          input: {
            notes:
              "Recorded fixture detail remains readable inside a lifecycle node.",
            pass,
          },
          nodeId,
        },
        sequence,
        type: "node:start",
      }
    : {
        executionId,
        payload: {
          nodeId,
          result: {
            output: {
              notes:
                "Completed fixture detail remains readable inside a lifecycle node.",
              pass,
            },
          },
        },
        sequence,
        type: "node:finish",
      };
});

const lifecycleBlueprint = {
  blobHash: "a".repeat(40),
  edges: [
    { source: "measure", target: "catalogue" },
    { source: "catalogue", target: "plan" },
    { source: "plan", target: "prepare" },
    { source: "prepare", target: "arrange" },
    { source: "arrange", target: "inspect" },
    { source: "inspect", target: "finish" },
    { source: "inspect", target: "refine" },
    { source: "refine", target: "arrange" },
  ],
  id: "room-refresh",
  nodes: [
    { id: "measure", uses: "wait" },
    { id: "catalogue", uses: "wait" },
    { id: "plan", uses: "wait" },
    { id: "prepare", uses: "wait" },
    { id: "arrange", uses: "wait" },
    { id: "inspect", uses: "wait" },
    { id: "refine", uses: "wait" },
    { id: "finish", uses: "wait" },
  ],
  path: "blueprints/room-refresh.json",
};

const editableArtifact = {
  $schema: "https://wyrd.company/heddle/lifecycle-blueprint.schema.json",
  edges: [{ source: "measure", target: "arrange" }],
  metadata: {
    canvas: {
      positions: {
        arrange: { x: 340, y: 40 },
        measure: { x: 40, y: 140 },
      },
    },
  },
  nodes: [
    { id: "measure", uses: "step" },
    { id: "arrange", uses: "step" },
  ],
  relationships: { implements: "heddle" },
};

const question = ({ header, id, prompt }) => ({
  ...(header === undefined ? {} : { header }),
  id,
  multiSelect: false,
  options: [
    {
      description: "Use the smaller available arrangement.",
      label: "Compact",
    },
    {
      description: "Use the larger available arrangement.",
      label: "Expanded",
    },
  ],
  question: prompt,
});

const longAttentionId = "recovery-record-".padEnd(128, "x");
const longSessionId = "sample-session-".padEnd(128, "y");
const longVisibleMessageToken = "sample-record-".padEnd(128, "z");

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
        actionId: "incident.production-mutation.approve",
        contract: {
          instanceId: "instance-43",
          kind: "incident.production-mutation.approve",
          proposalDigest: "a".repeat(64),
        },
        input: { kind: "none" },
        label: "Approve production mutation",
      },
    ],
    attentionId: "incident-mutation-approval-a",
    instanceId: "instance-43",
    kind: "incident-production-mutation-approval",
    message:
      "An accepted incident proposal requires production mutation approval.",
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
    kind: "stale-instance",
    message: "One catalogue pass has not changed recently.",
    scope: "task:42",
    taskId: 42,
  }),
  createConsoleAttention({
    actions: [],
    attentionId: "repository-a",
    kind: "blueprint-repository",
    message: "The room plan catalogue requires inspection.",
    scope: "all",
  }),
  createConsoleAttention({
    actions: [],
    attentionId: "ended-a",
    instanceId: "instance-43",
    kind: "ended",
    message: "A measurement session ended before recording its result.",
    scope: "task:43",
    taskId: 43,
  }),
  createConsoleAttention({
    actions: [],
    attentionId: "failed-a",
    instanceId: longSessionId,
    kind: "failed",
    message: "A supply-count session failed before recording its result.",
    scope: "task:43",
    taskId: 43,
  }),
  createConsoleAttention({
    actions: [],
    attentionId: "stalled-a",
    instanceId: "instance-43",
    kind: "stalled",
    message: "A shelf-label session has not reported progress.",
    scope: "task:43",
    taskId: 43,
  }),
  createConsoleAttention({
    actions: [],
    attentionId: "acceptance-a",
    kind: "epic-acceptance",
    message: "The room plan needs an acceptance record.",
    scope: "epic:40",
    taskId: 40,
  }),
  createConsoleAttention({
    actions: [],
    attentionId: "lifecycle-a",
    instanceId: "instance-43",
    kind: "lifecycle-resolution",
    message: "The room plan needs a process selection.",
    scope: "task:43",
    taskId: 43,
  }),
  createConsoleAttention({
    actions: [
      {
        actionId: "notification.retry",
        contract: { kind: "notification.retry", occurrence: 1 },
        input: { kind: "none" },
        label: "Retry notification",
      },
    ],
    attentionId: "notification-recovery-a",
    instanceId: "instance-43",
    kind: "production-error",
    message: "A notification requires verified recovery.",
    notificationVerification: {
      message: "A sample needs attention.",
      recipientLabel: "Primary operator",
    },
    scope: "task:43",
    taskId: 43,
  }),
  createConsoleAttention({
    actions: [
      {
        actionId: "notification.retry",
        contract: { kind: "notification.retry", occurrence: 2 },
        input: { kind: "none" },
        label: "Retry notification",
      },
    ],
    attentionId: longAttentionId,
    instanceId: longSessionId,
    kind: "production-error",
    message: `The ${longVisibleMessageToken} notification requires verified recovery.`,
    notificationVerification: {
      message:
        "A deliberately long sample message must remain fully visible without horizontal scrolling.",
      recipientLabel:
        "Secondary operator label that remains readable at the narrowest supported viewport",
    },
    scope: "task:43",
    taskId: 43,
  }),
];

const clone = (value) => JSON.parse(JSON.stringify(value));

const deferred = () => {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

export const createConsoleQualificationFixture = async () => {
  const repositoryRoot = await mkdtemp(
    join(tmpdir(), "heddle-console-editor-"),
  );
  try {
    await executeFile("git", ["init", "--quiet"], { cwd: repositoryRoot });
    await mkdir(join(repositoryRoot, "blueprints"));
    await writeFile(
      join(repositoryRoot, "blueprints", "room-refresh.json"),
      `${JSON.stringify(editableArtifact, null, 2)}\n`,
    );
  } catch (error) {
    await rm(repositoryRoot, { force: true, recursive: true });
    throw error;
  }

  let tasks = clone(initialTasks);
  let boardStatuses = ["todo", "in-progress", "done"];
  let resolvedAttention = new Set();
  let lifecycleTrace = [];
  let lifecyclePinnedBlobHash = lifecycleBlueprint.blobHash;
  let lifecycleTargetBlobHash = lifecycleBlueprint.blobHash;
  let lifecycleTargetState = "inspected";
  let lifecycleRebases = [];
  let actions = [];
  let boardWrites = [];
  let blueprintLoads = [];
  let blueprintLoadResults = [];
  let blueprintSaves = [];
  let blueprintSaveResults = [];
  let loadGate = deferred();
  let saveGate = deferred();

  const repositoryEditor = new BlueprintArtifactEditor({
    effects: {
      step: async () => ({ complete: true }),
    },
    repositoryRoot,
  });
  const blueprintEditor = {
    async load(artifactId) {
      blueprintLoads.push(artifactId);
      await loadGate.promise;
      const revision = await repositoryEditor.load(artifactId);
      blueprintLoadResults.push(clone(revision));
      return revision;
    },
    async save(input) {
      blueprintSaves.push(clone(input));
      await saveGate.promise;
      const revision = await repositoryEditor.save(input);
      blueprintSaveResults.push(clone(revision));
      return revision;
    },
  };

  const state = {
    async listAttention() {
      return attentionCatalog().filter(
        ({ attentionId }) => !resolvedAttention.has(attentionId),
      );
    },
    async listCorrelationTokens() {
      return [];
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
        [0, lifecycleEvents.slice(0, 116)],
        [116, lifecycleEvents.slice(116, 117)],
        [117, lifecycleEvents.slice(117, 118)],
        [118, []],
      ]);
      const events = tails.get(afterSequence);
      if (events === undefined)
        throw new Error("fixture lifecycle cursor is unknown");
      return {
        blueprint: {
          ...lifecycleBlueprint,
          blobHash: lifecyclePinnedBlobHash,
        },
        currentStageIds: ["arrange"],
        events,
        instanceId: "instance-43",
        nextSequence: events.at(-1)?.sequence ?? 118,
        rebase:
          lifecycleTargetState === "upstream-target-unavailable"
            ? { state: "upstream-target-unavailable" }
            : {
                state:
                  lifecyclePinnedBlobHash === lifecycleTargetBlobHash
                    ? "current"
                    : "available",
                targetBlueprintBlobHash: lifecycleTargetBlobHash,
                targetStateIds: ["arrange"],
              },
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
      return clone(boardStatuses);
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
  const lifecycleActions = {
    async rebase(input) {
      if (lifecycleTargetState === "upstream-target-unavailable") {
        throw new Error("fixture upstream target is unavailable");
      }
      lifecycleRebases.push(clone(input));
      lifecyclePinnedBlobHash = lifecycleTargetBlobHash;
    },
  };

  const server = createConsoleServer({
    actions: actionPort,
    board,
    blueprintEditor,
    lifecycleActions,
    now: () => 18_000_000_000,
    state,
  });

  return {
    actions: () => clone(actions),
    advanceLifecycleBlueprint() {
      lifecycleTargetState = "inspected";
      lifecycleTargetBlobHash = "b".repeat(40);
    },
    blueprintRequests: () =>
      clone({
        loadResults: blueprintLoadResults,
        loads: blueprintLoads,
        saveResults: blueprintSaveResults,
        saves: blueprintSaves,
      }),
    boardWrites: () => clone(boardWrites),
    cleanup: () => rm(repositoryRoot, { force: true, recursive: true }),
    lifecycleRebases: () => clone(lifecycleRebases),
    lifecycleTrace: () => clone(lifecycleTrace),
    removeLifecycleBlueprintFromUpstream() {
      lifecycleTargetState = "upstream-target-unavailable";
    },
    prepareBlueprintEditor() {
      blueprintLoads = [];
      blueprintLoadResults = [];
      blueprintSaves = [];
      blueprintSaveResults = [];
      loadGate = deferred();
      saveGate = deferred();
    },
    releaseBlueprintLoad() {
      loadGate.resolve();
    },
    releaseBlueprintSave() {
      saveGate.resolve();
    },
    reset() {
      tasks = clone(initialTasks);
      boardStatuses = ["todo", "in-progress", "done"];
      resolvedAttention = new Set();
      lifecycleTrace = [];
      lifecyclePinnedBlobHash = lifecycleBlueprint.blobHash;
      lifecycleTargetBlobHash = lifecycleBlueprint.blobHash;
      lifecycleTargetState = "inspected";
      lifecycleRebases = [];
      actions = [];
      boardWrites = [];
    },
    setEpicStatus(status) {
      tasks.find(({ id }) => id === 40).status = status;
      if (status === "uat") {
        tasks.find(({ id }) => id === 42).status = "todo";
        boardStatuses = ["todo", "uat", "done"];
      }
    },
    makeLifecycleSourceUnresolvable() {
      lifecycleTargetState = "upstream-target-unavailable";
    },
    server,
    attentionHeadings: attentionCatalog().map(
      ({ attentionId, fingerprint, heading, instanceId, kind, scope }) => ({
        attentionId,
        fingerprint,
        heading,
        instanceId,
        kind,
        scope,
      }),
    ),
    currentAttentionKinds: Object.keys(CONSOLE_ATTENTION_KIND_LABELS),
    stableAttentionIds: attentionCatalog().map(
      ({ attentionId }) => attentionId,
    ),
  };
};
