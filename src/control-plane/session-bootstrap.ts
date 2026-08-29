// ---
// relationships:
//   implements: heddle
//   references: t3-headless
// ---

import type { JsonValue } from "../persistence/index.js";
import type { InstanceRecord } from "../persistence/index.js";
import { GitBlueprintStore } from "../engine/index.js";
import type { WorkflowMcpStageContract } from "../mcp-server/types.js";
import { isWorkflowMcpStageContract } from "../mcp-server/stage-contract.js";
import {
  ensureStageTodoList,
  instantiateTodoList,
  stageTodoStateForHandoff,
} from "../todo/index.js";
import {
  ensureCorrelationToken,
  type InstanceStateStore,
} from "./correlation-token.js";
import {
  assembleStageHandoff,
  type StageHandoffInput,
} from "./handoff-assembler.js";
import type {
  T3DispatchCommand,
  T3ProviderDispatchContext,
} from "./t3-control-plane-client.js";
import {
  ensureWorktree,
  type PreparedWorktree,
  type WorktreeInput,
} from "./worktree-creator.js";

type StoredStageHandoffCandidate = {
  [key: string]: JsonValue;
  correlationToken: string;
  handoff: string;
  kind: "stage-handoff";
  sessionKey: string;
};

export interface SessionT3Client {
  dispatch(
    command: T3DispatchCommand,
    providerContext?: T3ProviderDispatchContext,
  ): Promise<{ sequence: number }>;
}

export type SessionBootstrapInput = {
  handoff: Omit<StageHandoffInput, "correlationToken" | "todoList">;
  instanceId: string;
  interactionMode: string;
  modelSelection: { instanceId: string; model: string };
  projectId: string;
  providerContext: T3ProviderDispatchContext;
  runtimeMode: string;
  sessionKey: string;
  title: string;
  worktree: WorktreeInput;
};

export type SessionBootstrapResult = {
  correlationToken: string;
  harnessConfiguration: HarnessConfiguration;
  handoff: string;
  threadId: string;
  worktree: PreparedWorktree;
};

export type HarnessConfiguration = {
  claudeCode: {
    permissions: { deny: ["TodoWrite"] };
  };
  codex: {
    tools: { update_plan: { enabled: false } };
  };
};

export const harnessConfiguration = (): HarnessConfiguration => ({
  claudeCode: { permissions: { deny: ["TodoWrite"] } },
  codex: { tools: { update_plan: { enabled: false } } },
});

export type SessionBootstrapDependencies = {
  ensureWorktree?: (input: WorktreeInput) => Promise<PreparedWorktree>;
  instantiateTodoList?: typeof instantiateTodoList;
  mintCorrelationToken?: () => string;
  nextId?: () => string;
  now?: () => string;
  persistence: InstanceStateStore;
  resolveWorkflowMcpStageContract?: WorkflowMcpStageContractResolver;
  t3: SessionT3Client;
};

export type WorkflowMcpStageContractResolver = (
  input: SessionBootstrapInput,
  record: InstanceRecord,
) => Promise<WorkflowMcpStageContract>;

export type SessionSteeringInput = {
  interactionMode: string;
  message: string;
  providerContext: T3ProviderDispatchContext;
  runtimeMode: string;
  threadId: string;
};

export type SessionSteeringDependencies = {
  nextId?: () => string;
  now?: () => string;
  t3: SessionT3Client;
};

const isStoredHandoff = (
  value: JsonValue,
): value is StoredStageHandoffCandidate =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  value["kind"] === "stage-handoff" &&
  typeof value["sessionKey"] === "string" &&
  typeof value["correlationToken"] === "string" &&
  typeof value["handoff"] === "string";

const resolveWorkflowMcpStageContract: WorkflowMcpStageContractResolver =
  async (input, record) => {
    const context = record.state.flowcraftContext;
    if (
      typeof context !== "object" ||
      context === null ||
      Array.isArray(context) ||
      typeof context["blueprintBlobHash"] !== "string" ||
      typeof context["blueprintPath"] !== "string" ||
      !Array.isArray(context["awaitingNodeIds"]) ||
      context["awaitingNodeIds"].length !== 1 ||
      context["awaitingNodeIds"][0] !== input.handoff.stage.name
    ) {
      throw new Error(
        "Stage session bootstrap does not match the awaiting lifecycle stage",
      );
    }
    const blueprint = await new GitBlueprintStore(
      input.worktree.repositoryRoot,
    ).read(context["blueprintBlobHash"], context["blueprintPath"]);
    const stage = blueprint.nodes.find(
      ({ id }) => id === input.handoff.stage.name,
    );
    if (
      stage?.uses !== "wait" ||
      !Array.isArray(stage.tools) ||
      typeof stage["todo-template"] !== "string"
    ) {
      throw new Error(
        "Stage session bootstrap requires a wait-stage tool declaration",
      );
    }
    const dispositions = blueprint.edges
      .filter(
        ({ disposition, source }) =>
          source === stage.id && disposition !== undefined,
      )
      .map(({ description, disposition }) => {
        if (
          disposition === undefined ||
          description === undefined ||
          description.trim() === ""
        ) {
          throw new Error(
            "Stage session bootstrap requires a description for every disposition",
          );
        }
        return { description, name: disposition };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      blueprintBlobHash: context["blueprintBlobHash"],
      blueprintPath: context["blueprintPath"],
      dispositions,
      stage: stage.id,
      todoTemplate: stage["todo-template"],
      tools: [...stage.tools],
    };
  };

const ensureStoredHandoff = async (
  store: InstanceStateStore,
  input: SessionBootstrapInput,
  correlationToken: string,
  resolveStageContract: WorkflowMcpStageContractResolver,
  instantiate: typeof instantiateTodoList,
): Promise<string> => {
  while (true) {
    const current = store.getInstance(input.instanceId);
    if (current === undefined) {
      throw new Error(`Instance does not exist: ${input.instanceId}`);
    }
    const existing = current.state.handoffs
      .filter(isStoredHandoff)
      .find(({ sessionKey }) => sessionKey === input.sessionKey);
    if (existing !== undefined) {
      if (existing.correlationToken !== correlationToken) {
        throw new Error(
          `Stored handoff and correlation token disagree for '${input.sessionKey}'`,
        );
      }
      const workflowMcp = existing["workflowMcp"];
      if (
        workflowMcp === undefined ||
        !isWorkflowMcpStageContract(workflowMcp)
      ) {
        throw new Error(
          `Stored handoff has no valid workflow MCP contract for '${input.sessionKey}'`,
        );
      }
      if (workflowMcp.stage !== input.handoff.stage.name) {
        throw new Error(
          `Stored handoff and workflow MCP stage disagree for '${input.sessionKey}'`,
        );
      }
      return existing.handoff;
    }

    const templateContract = await resolveStageContract(input, current);
    await ensureStageTodoList(
      store,
      {
        instanceId: input.instanceId,
        repositoryRoot: input.worktree.repositoryRoot,
        sessionKey: input.sessionKey,
        stage: templateContract.stage,
        taskContract: input.handoff.taskContract,
        templateId: templateContract.todoTemplate,
      },
      instantiate,
    );
    const refreshed = store.getInstance(input.instanceId);
    if (refreshed === undefined) {
      throw new Error(`Instance does not exist: ${input.instanceId}`);
    }
    if (
      refreshed.state.handoffs
        .filter(isStoredHandoff)
        .some(({ sessionKey }) => sessionKey === input.sessionKey)
    ) {
      continue;
    }
    const workflowMcp = await resolveStageContract(input, refreshed);
    const { list: todoList, state: todoState } = stageTodoStateForHandoff(
      refreshed,
      input.sessionKey,
      workflowMcp.stage,
      refreshed.state.handoffs
        .filter(isStoredHandoff)
        .map(({ sessionKey }) => sessionKey),
    );
    if (todoList.template !== workflowMcp.todoTemplate) {
      throw new Error(
        `Stored todo list does not match stage contract for '${input.sessionKey}'`,
      );
    }
    const handoff = assembleStageHandoff({
      ...input.handoff,
      correlationToken,
      todoList: todoState,
    });
    const stored: StoredStageHandoffCandidate = {
      correlationToken,
      handoff,
      kind: "stage-handoff",
      sessionKey: input.sessionKey,
      workflowMcp,
    };
    const claimed = store.compareAndSwapInstance(
      input.instanceId,
      refreshed.version,
      {
        ...refreshed.state,
        handoffs: [...refreshed.state.handoffs, stored],
      },
    );
    if (claimed !== undefined) return handoff;
  }
};

export const bootstrapStageSession = async (
  input: SessionBootstrapInput,
  dependencies: SessionBootstrapDependencies,
): Promise<SessionBootstrapResult> => {
  const prepareWorktree = dependencies.ensureWorktree ?? ensureWorktree;
  const nextId = dependencies.nextId ?? (() => globalThis.crypto.randomUUID());
  const now = dependencies.now ?? (() => new Date().toISOString());
  const worktree = await prepareWorktree(input.worktree);
  const { token: correlationToken } = ensureCorrelationToken(
    dependencies.persistence,
    input.instanceId,
    input.sessionKey,
    dependencies.mintCorrelationToken,
  );
  const handoff = await ensureStoredHandoff(
    dependencies.persistence,
    input,
    correlationToken,
    dependencies.resolveWorkflowMcpStageContract ??
      resolveWorkflowMcpStageContract,
    dependencies.instantiateTodoList ?? instantiateTodoList,
  );
  const threadId = nextId();

  await dependencies.t3.dispatch({
    type: "thread.create",
    commandId: nextId(),
    threadId,
    projectId: input.projectId,
    title: input.title,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    branch: worktree.branch,
    worktreePath: worktree.path,
    createdAt: now(),
  });
  await dependencies.t3.dispatch(
    {
      type: "thread.turn.start",
      commandId: nextId(),
      threadId,
      message: {
        messageId: nextId(),
        role: "user",
        text: handoff,
        attachments: [],
      },
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      createdAt: now(),
    },
    input.providerContext,
  );

  return {
    correlationToken,
    handoff,
    harnessConfiguration: harnessConfiguration(),
    threadId,
    worktree,
  };
};

export const steerStageSession = async (
  input: SessionSteeringInput,
  dependencies: SessionSteeringDependencies,
): Promise<{ sequence: number }> => {
  const nextId = dependencies.nextId ?? (() => globalThis.crypto.randomUUID());
  const now = dependencies.now ?? (() => new Date().toISOString());
  return dependencies.t3.dispatch(
    {
      type: "thread.turn.start",
      commandId: nextId(),
      threadId: input.threadId,
      message: {
        messageId: nextId(),
        role: "user",
        text: input.message,
        attachments: [],
      },
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      createdAt: now(),
    },
    input.providerContext,
  );
};
