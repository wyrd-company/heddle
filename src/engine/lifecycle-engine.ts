// ---
// relationships:
//   implements: heddle
// ---

import type { WorkflowResult } from "flowcraft";

import type {
  InstanceRecord,
  InstanceState,
  JsonValue,
} from "../persistence/index.js";
import {
  dispositionsForNode,
  edgeForDisposition,
  expectedLanding,
  startLanding,
  validateBlueprint,
} from "./blueprint.js";
import { InvalidDispositionError, UnexpectedLandingError } from "./errors.js";
import {
  awaitingNodeIdsFrom,
  createLifecycleRuntime,
  executionIdFrom,
  landedAsExpected,
  prepareRuntimeBlueprint,
} from "./flowcraft-runtime.js";
import { GitBlueprintStore } from "./git-blueprint-store.js";
import type {
  ExpectedLanding,
  LifecycleBlueprint,
  LifecycleContextRecord,
  LifecycleEffect,
  LifecycleEngineOptions,
  LifecycleSnapshot,
  PendingTransition,
  ResumeLifecycleInput,
  StartLifecycleInput,
} from "./types.js";

const attentionEvent = "lifecycle:attention-required";

const asJsonValue = (value: unknown): JsonValue => value as JsonValue;

const readLifecycleContext = (
  record: InstanceRecord,
): LifecycleContextRecord => {
  const value = record.state.flowcraftContext;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("blueprintBlobHash" in value) ||
    typeof value.blueprintBlobHash !== "string" ||
    !("blueprintPath" in value) ||
    typeof value.blueprintPath !== "string" ||
    !("executionIds" in value) ||
    !Array.isArray(value.executionIds) ||
    !("awaitingNodeIds" in value) ||
    !Array.isArray(value.awaitingNodeIds) ||
    !("nextTransitionNumber" in value) ||
    typeof value.nextTransitionNumber !== "number"
  ) {
    throw new Error(
      `Instance ${JSON.stringify(record.instanceId)} does not contain lifecycle engine state`,
    );
  }
  return value as unknown as LifecycleContextRecord;
};

const writeLifecycleContext = (
  state: InstanceState,
  context: LifecycleContextRecord,
): InstanceState => ({
  ...state,
  flowcraftContext: asJsonValue(context),
});

const initialInstanceState = (
  input: StartLifecycleInput,
  context: LifecycleContextRecord,
): InstanceState => ({
  correlationTokens: input.state?.correlationTokens ?? {},
  flowcraftContext: asJsonValue(context),
  handoffs: input.state?.handoffs ?? [],
  todoState: input.state?.todoState ?? null,
});

export class LifecycleEngine {
  private readonly blueprintStore: GitBlueprintStore;
  private readonly effects: Record<string, LifecycleEffect>;
  private readonly persistence: LifecycleEngineOptions["persistence"];

  constructor(options: LifecycleEngineOptions) {
    this.blueprintStore = new GitBlueprintStore(options.repositoryRoot);
    this.effects = { ...options.effects };
    this.persistence = options.persistence;
  }

  async start(input: StartLifecycleInput): Promise<LifecycleSnapshot> {
    const existing = this.persistence.getInstance(input.instanceId);
    if (existing !== undefined) {
      const context = readLifecycleContext(existing);
      if (
        context.pendingTransition?.kind !== "start" ||
        context.blueprintPath !== input.blueprintPath
      ) {
        throw new Error(`Instance already exists: ${input.instanceId}`);
      }
      const blueprint = await this.blueprintStore.read(
        context.blueprintBlobHash,
      );
      validateBlueprint(blueprint, this.effects);
      return this.execute(existing, blueprint, startLanding(blueprint));
    }

    const pinned = await this.blueprintStore.pin(input.blueprintPath);
    validateBlueprint(pinned.blueprint, this.effects);
    const pendingTransition: PendingTransition = {
      disposition: null,
      id: `${input.instanceId}:1`,
      initialContext: input.initialContext ?? {},
      kind: "start",
      output: null,
    };
    const context: LifecycleContextRecord = {
      awaitingNodeIds: [],
      blueprintBlobHash: pinned.blobHash,
      blueprintPath: pinned.path,
      executionIds: [],
      nextTransitionNumber: 2,
      pendingTransition,
      serializedContext: null,
      status: "pending",
    };
    const record = this.persistence.createInstance(
      input.instanceId,
      initialInstanceState(input, context),
    );
    return this.execute(
      record,
      pinned.blueprint,
      startLanding(pinned.blueprint),
    );
  }

  async resume(input: ResumeLifecycleInput): Promise<LifecycleSnapshot> {
    let record = this.persistence.getInstance(input.instanceId);
    if (record === undefined) {
      throw new Error(`Instance does not exist: ${input.instanceId}`);
    }
    let context = readLifecycleContext(record);
    const blueprint = await this.blueprintStore.read(context.blueprintBlobHash);
    validateBlueprint(blueprint, this.effects);
    if (context.awaitingNodeIds.length !== 1) {
      throw new InvalidDispositionError(input.disposition, []);
    }
    const waitNodeId = context.awaitingNodeIds[0];
    if (waitNodeId === undefined) {
      throw new InvalidDispositionError(input.disposition, []);
    }
    const validDispositions = dispositionsForNode(blueprint, waitNodeId);
    const edge = edgeForDisposition(blueprint, waitNodeId, input.disposition);
    if (edge === undefined) {
      throw new InvalidDispositionError(input.disposition, validDispositions);
    }
    if (
      input.output !== undefined &&
      (Object.hasOwn(input.output, "disposition") ||
        Object.hasOwn(input.output, "dispositions"))
    ) {
      throw new TypeError(
        "Resume output must not contain reserved disposition fields",
      );
    }

    if (context.pendingTransition !== null) {
      if (
        context.pendingTransition.kind !== "resume" ||
        context.pendingTransition.disposition !== input.disposition
      ) {
        throw new Error(
          `Instance ${JSON.stringify(input.instanceId)} has a different pending transition`,
        );
      }
    } else {
      const pendingTransition: PendingTransition = {
        disposition: input.disposition,
        id: `${input.instanceId}:${context.nextTransitionNumber}`,
        initialContext: null,
        kind: "resume",
        output: input.output ?? {},
      };
      context = {
        ...context,
        nextTransitionNumber: context.nextTransitionNumber + 1,
        pendingTransition,
      };
      record = this.persistence.updateInstance(
        input.instanceId,
        writeLifecycleContext(record.state, context),
      );
    }

    return this.execute(
      record,
      blueprint,
      expectedLanding(blueprint, [edge.target]),
    );
  }

  private async execute(
    record: InstanceRecord,
    blueprint: LifecycleBlueprint,
    expected: ExpectedLanding,
  ): Promise<LifecycleSnapshot> {
    const lifecycleContext = readLifecycleContext(record);
    const pending = lifecycleContext.pendingTransition;
    if (pending === null) {
      throw new Error("Lifecycle transition is not pending");
    }
    const runtime = createLifecycleRuntime(
      blueprint,
      this.effects,
      this.persistence.flowcraftHistory,
      pending,
    );
    const runtimeBlueprint = prepareRuntimeBlueprint(blueprint);
    let result: WorkflowResult;
    if (pending.kind === "start") {
      result = await runtime.run(runtimeBlueprint, {
        ...(pending.initialContext ?? {}),
        _heddleInstanceId: record.instanceId,
      });
    } else {
      if (lifecycleContext.serializedContext === null) {
        throw new Error("Resumable Flowcraft context is missing");
      }
      const waitNodeId = lifecycleContext.awaitingNodeIds[0];
      if (waitNodeId === undefined || pending.disposition === null) {
        throw new Error("Pending resume does not identify a wait disposition");
      }
      result = await runtime.resume(
        runtimeBlueprint,
        lifecycleContext.serializedContext,
        {
          output: {
            ...(pending.output ?? {}),
            disposition: pending.disposition,
            dispositions: { [pending.disposition]: true },
          },
        },
        waitNodeId,
      );
    }

    if (!landedAsExpected(result, expected)) {
      this.persistence.appendEvent(record.instanceId, attentionEvent, {
        actualAwaitingNodeIds: awaitingNodeIdsFrom(result.serializedContext),
        actualStatus: result.status,
        expectedAwaitingNodeIds: expected.awaitingNodeIds,
        expectedTerminalNodeIds: expected.terminalNodeIds,
        transitionId: pending.id,
      });
      throw new UnexpectedLandingError(
        record.instanceId,
        expected,
        result.status,
      );
    }

    const executionId = executionIdFrom(result.serializedContext);
    const executionIds =
      executionId === undefined ||
      lifecycleContext.executionIds.includes(executionId)
        ? lifecycleContext.executionIds
        : [...lifecycleContext.executionIds, executionId];
    const nextContext: LifecycleContextRecord = {
      ...lifecycleContext,
      awaitingNodeIds: awaitingNodeIdsFrom(result.serializedContext),
      executionIds,
      pendingTransition: null,
      serializedContext: result.serializedContext,
      status: result.status,
    };
    const current = this.persistence.getInstance(record.instanceId);
    if (current === undefined) {
      throw new Error(`Instance does not exist: ${record.instanceId}`);
    }
    this.persistence.updateInstance(
      record.instanceId,
      writeLifecycleContext(current.state, nextContext),
    );
    return this.snapshot(record.instanceId, nextContext, blueprint);
  }

  private snapshot(
    instanceId: string,
    context: LifecycleContextRecord,
    blueprint: LifecycleBlueprint,
  ): LifecycleSnapshot {
    const waitNodeId = context.awaitingNodeIds[0];
    return {
      awaitingNodeIds: [...context.awaitingNodeIds],
      blueprintBlobHash: context.blueprintBlobHash,
      blueprintPath: context.blueprintPath,
      executionIds: [...context.executionIds],
      instanceId,
      status: context.status === "pending" ? "stalled" : context.status,
      validDispositions:
        waitNodeId === undefined
          ? []
          : dispositionsForNode(blueprint, waitNodeId),
    };
  }
}
