// ---
// relationships:
//   implements: heddle
// ---

import type { WorkflowResult } from "flowcraft";

import type { InstanceRecord } from "../persistence/index.js";
import {
  dispositionsForNode,
  edgeForDisposition,
  expectedLanding,
  startLanding,
  validateBlueprint,
} from "./blueprint.js";
import {
  InvalidDispositionError,
  TransitionConflictError,
  UnexpectedLandingError,
} from "./errors.js";
import {
  awaitingNodeIdsFrom,
  createLifecycleRuntime,
  executionIdFrom,
  landedAsExpected,
  prepareRuntimeBlueprint,
} from "./flowcraft-runtime.js";
import { GitBlueprintStore } from "./git-blueprint-store.js";
import {
  completedOperationForTransition,
  initialInstanceState,
  persistExecution,
  readLifecycleContext,
  resumeOperationFingerprint,
  writeLifecycleContext,
} from "./lifecycle-state.js";
import type {
  CompletedLifecycleOperation,
  ExpectedLandings,
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
        context.blueprintPath !==
          this.blueprintStore.normalize(input.blueprintPath)
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
      operationId: null,
      output: null,
      requestFingerprint: null,
    };
    const context: LifecycleContextRecord = {
      awaitingNodeIds: [],
      blueprintBlobHash: pinned.blobHash,
      blueprintPath: pinned.path,
      completedOperations: {},
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
    if (input.operationId.trim() === "") {
      throw new TypeError("Resume operation ID must not be empty");
    }
    let record = this.persistence.getInstance(input.instanceId);
    if (record === undefined) {
      throw new Error(`Instance does not exist: ${input.instanceId}`);
    }
    let context = readLifecycleContext(record);
    const blueprint = await this.blueprintStore.read(context.blueprintBlobHash);
    validateBlueprint(blueprint, this.effects);
    const requestFingerprint = resumeOperationFingerprint(input);
    if (Object.hasOwn(context.completedOperations, input.operationId)) {
      const completed = context.completedOperations[input.operationId]!;
      if (completed.requestFingerprint !== requestFingerprint) {
        throw new TransitionConflictError(input.instanceId);
      }
      return this.snapshot(
        input.instanceId,
        this.contextForCompletedOperation(context, completed),
        blueprint,
      );
    }
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
        context.pendingTransition.disposition !== input.disposition ||
        context.pendingTransition.operationId !== input.operationId ||
        context.pendingTransition.requestFingerprint !== requestFingerprint
      ) {
        throw new TransitionConflictError(input.instanceId);
      }
    } else {
      const pendingTransition: PendingTransition = {
        disposition: input.disposition,
        id: `${input.instanceId}:${context.nextTransitionNumber}`,
        initialContext: null,
        kind: "resume",
        operationId: input.operationId,
        output: input.output ?? {},
        requestFingerprint,
      };
      context = {
        ...context,
        nextTransitionNumber: context.nextTransitionNumber + 1,
        pendingTransition,
      };
      const claimed = this.persistence.compareAndSwapInstance(
        input.instanceId,
        record.version,
        writeLifecycleContext(record.state, context),
      );
      if (claimed === undefined) {
        throw new TransitionConflictError(input.instanceId);
      }
      record = claimed;
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
    expected: ExpectedLandings,
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

    const executionId = executionIdFrom(result.serializedContext);
    const executionEvents =
      executionId === undefined
        ? []
        : await this.persistence.flowcraftHistory.replay(executionId);
    if (!landedAsExpected(result, expected, blueprint, executionEvents)) {
      const nextContext = persistExecution(
        this.persistence,
        record.instanceId,
        pending.id,
        executionId,
      );
      const completedOperation = completedOperationForTransition(
        nextContext,
        pending.id,
      );
      this.persistence.appendEvent(record.instanceId, attentionEvent, {
        actualAwaitingNodeIds: awaitingNodeIdsFrom(result.serializedContext),
        actualStatus: result.status,
        expectedAwaitingNodeIds: [
          ...new Set(
            expected.flatMap(({ awaitingNodeIds }) => awaitingNodeIds),
          ),
        ].sort(),
        expectedTerminalNodeIds: [
          ...new Set(
            expected.flatMap(({ terminalNodeIds }) => terminalNodeIds),
          ),
        ].sort(),
        transitionId: pending.id,
      });
      if (completedOperation !== undefined) {
        return this.snapshot(
          record.instanceId,
          this.contextForCompletedOperation(nextContext, completedOperation),
          blueprint,
        );
      }
      throw new UnexpectedLandingError(
        record.instanceId,
        expected,
        result.status,
      );
    }

    const nextContext = persistExecution(
      this.persistence,
      record.instanceId,
      pending.id,
      executionId,
      {
        awaitingNodeIds: awaitingNodeIdsFrom(result.serializedContext),
        serializedContext: result.serializedContext,
        status: result.status,
      },
    );
    const completedOperation = completedOperationForTransition(
      nextContext,
      pending.id,
    );
    return this.snapshot(
      record.instanceId,
      completedOperation === undefined
        ? nextContext
        : this.contextForCompletedOperation(nextContext, completedOperation),
      blueprint,
    );
  }

  private contextForCompletedOperation(
    context: LifecycleContextRecord,
    completedOperation: CompletedLifecycleOperation,
  ): LifecycleContextRecord {
    return {
      ...context,
      awaitingNodeIds: completedOperation.awaitingNodeIds,
      executionIds: completedOperation.executionIds,
      status: completedOperation.status,
    };
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
