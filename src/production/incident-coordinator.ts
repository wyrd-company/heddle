// ---
// relationships:
//   implements: heddle
// ---

import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import process from "node:process";

import type { BoardTask } from "../board-adapter/index.js";
import {
  readLifecycleContext,
  type LifecycleContextRecord,
  type LifecycleSnapshot,
} from "../engine/index.js";
import type {
  IncidentRuntimeRecord,
  JsonValue,
  SqlitePersistence,
} from "../persistence/index.js";
import type { DurableAttentionQueue } from "./durable-adapters.js";
import {
  createProductionErrorAttention,
  productionErrorCodeDeclarations,
  productionErrorIncidentEligible,
  productionErrorIncidentId,
  type ProductionErrorAttention,
} from "./error-visibility.js";
import type { ProductionInstanceController } from "./instance-controller.js";
import type { ProductionLifecycleRouter } from "./lifecycle-router.js";
import { sanitizeIncidentValue } from "./incident-redaction.js";
import {
  incidentProductionMutationApproval,
  incidentProductionMutationApproved,
  incidentProposedActionKinds,
} from "./incident-approval.js";

export { sanitizeIncidentValue } from "./incident-redaction.js";

export const incidentAdmissionPolicy = {
  cooldownMilliseconds: 60_000,
  maximumConcurrent: 3,
  maximumReviewRejections: 3,
} as const;

const incidentBlueprintPath = "blueprints/incident.json";
const finalizeEffect = "incident-finalize";

type RecordValue = Record<string, JsonValue>;

const asRecord = (value: JsonValue | undefined): RecordValue | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;

const productionError = (
  value: JsonValue,
): ProductionErrorAttention | undefined => {
  const payload = asRecord(value);
  const code = payload?.["code"];
  if (
    payload?.["kind"] !== "production-error" ||
    typeof code !== "string" ||
    !Object.hasOwn(productionErrorCodeDeclarations, code)
  ) {
    return undefined;
  }
  return payload as ProductionErrorAttention;
};

const executableOnPath = async (name: string): Promise<boolean> => {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (directory === "") continue;
    try {
      await access(join(directory, name), constants.X_OK);
      return true;
    } catch {
      // Continue through the service process PATH.
    }
  }
  return false;
};

const sourceTaskContract = (
  persistence: SqlitePersistence,
  sourceInstanceId: string | undefined,
): Partial<BoardTask> | undefined => {
  if (sourceInstanceId === undefined) return undefined;
  const instance = persistence.getInstance(sourceInstanceId);
  if (instance === undefined) return undefined;
  const serialized = readLifecycleContext(instance).serializedContext;
  if (serialized === null) return undefined;
  const context = JSON.parse(serialized) as Record<string, unknown>;
  const candidate = context["taskContract"];
  return typeof candidate === "object" &&
    candidate !== null &&
    !Array.isArray(candidate)
    ? (candidate as Partial<BoardTask>)
    : undefined;
};

const taskForIncident = (
  persistence: SqlitePersistence,
  boardTasks: readonly BoardTask[],
  attention: ProductionErrorAttention,
  incident: JsonValue,
): BoardTask => {
  const boardTask = boardTasks.find(({ id }) => id === attention.taskId);
  const retained =
    boardTask === undefined
      ? sourceTaskContract(persistence, attention.instanceId ?? undefined)
      : undefined;
  const taskId = attention.taskId;
  if (taskId === null) throw new Error("Incident attention has no task ID");
  const base: BoardTask = boardTask ?? {
    blocked: retained?.blocked ?? false,
    dependencies: retained?.dependencies ?? [],
    frontMatter: {},
    id: taskId,
    priority: retained?.priority ?? "medium",
    status: retained?.status ?? "in-progress",
    tags: retained?.tags ?? [],
    title: retained?.title ?? `Production incident for task ${taskId}`,
    ...(retained?.lifecycle === undefined
      ? {}
      : { lifecycle: retained.lifecycle }),
    ...(retained?.parent === undefined ? {} : { parent: retained.parent }),
    ...(retained?.product === undefined ? {} : { product: retained.product }),
    ...(retained?.repos === undefined ? {} : { repos: retained.repos }),
  };
  return { ...base, frontMatter: {}, incident } as BoardTask;
};

export class ProductionIncidentCoordinator {
  public constructor(
    private readonly persistence: SqlitePersistence,
    private readonly attention: DurableAttentionQueue,
    private readonly lifecycle: ProductionLifecycleRouter,
    private readonly instances: ProductionInstanceController,
    private readonly options: {
      commandAvailable?: (name: string) => Promise<boolean>;
      now?: () => number;
      secrets?: readonly string[];
    } = {},
  ) {}

  async reconcile(tasks: readonly BoardTask[]): Promise<void> {
    const taskIds = new Set(tasks.map(({ id }) => id));
    for (const record of this.persistence.listAttention()) {
      const source = productionError(record.payload);
      if (source === undefined) continue;
      if (!productionErrorIncidentEligible(source.code)) continue;
      if (source.taskId === null) continue;
      if (
        source.instanceId !== null &&
        this.persistence
          .listIncidentRuntime()
          .some(({ incidentId }) => incidentId === source.instanceId)
      ) {
        continue;
      }
      const incidentId = productionErrorIncidentId(source.attentionId);
      const admission = this.persistence.admitIncident({
        attentionId: source.attentionId,
        code: source.code,
        cooldownMilliseconds: incidentAdmissionPolicy.cooldownMilliseconds,
        createdAt: this.options.now?.() ?? Date.now(),
        incidentId,
        maximumConcurrent: incidentAdmissionPolicy.maximumConcurrent,
        ...(source.instanceId === null
          ? {}
          : { sourceInstanceId: source.instanceId }),
        taskId: source.taskId,
      });
      if (admission.kind === "suppressed") continue;
      await this.#synchronize(
        admission.runtime,
        tasks,
        taskIds.has(source.taskId),
      );
    }
    for (const runtime of this.persistence.listIncidentRuntime()) {
      if (runtime.state === "done" || runtime.state === "failed") continue;
      if (await this.attention.has(runtime.attentionId)) {
        await this.#synchronize(runtime, tasks, taskIds.has(runtime.taskId));
      }
    }
  }

  async resume(input: {
    disposition: string;
    instanceId: string;
    operationId: string;
    output?: Record<string, JsonValue>;
  }): Promise<LifecycleSnapshot> {
    const runtime = this.persistence
      .listIncidentRuntime()
      .find(({ incidentId }) => incidentId === input.instanceId);
    if (runtime === undefined) return this.lifecycle.resume(input);
    let intended = runtime;
    if (runtime.stageId === "review" && input.disposition === "reject") {
      const rejections = new Set(runtime.rejectionOperationIds);
      rejections.add(input.operationId);
      if (rejections.size > incidentAdmissionPolicy.maximumReviewRejections) {
        await this.#fail(
          runtime,
          new Error("Incident review rejection bound exhausted"),
        );
        throw new Error(
          `Incident review rejection bound of ${incidentAdmissionPolicy.maximumReviewRejections} is exhausted`,
        );
      }
      intended = {
        ...runtime,
        rejectionOperationIds: [...rejections],
      };
    }
    if (runtime.stageId === "finalize" && input.disposition === "complete") {
      this.#assertFinalizationAuthorized(runtime);
    }
    if (runtime.stageId === "implement" && input.disposition === "diagnosed") {
      intended = { ...intended, diagnosis: input.output ?? {} };
    }
    if (runtime.stageId === "review" && input.disposition === "approve") {
      intended = { ...intended, accepted: true };
    }
    this.persistence.writeIncidentRuntime(intended);
    const snapshot = await this.lifecycle.resume(input);
    const next = this.persistence
      .listIncidentRuntime()
      .find(({ incidentId }) => incidentId === runtime.incidentId)!;
    try {
      await this.#synchronizeSnapshot(next, snapshot, []);
    } catch (error) {
      await this.#fail(next, error);
    }
    return snapshot;
  }

  async #synchronize(
    runtime: IncidentRuntimeRecord,
    tasks: readonly BoardTask[],
    taskOnBoard: boolean,
  ): Promise<void> {
    try {
      const record = this.persistence.getInstance(runtime.incidentId);
      if (record === undefined) {
        const stageId = await this.lifecycle.plannedStartStage({
          blueprintPath: incidentBlueprintPath,
          instanceId: runtime.incidentId,
        });
        if (stageId === undefined) {
          throw new Error("Incident lifecycle has no initial agent stage");
        }
        runtime = this.instances.prepareIncidentStart(runtime, stageId);
        const source = this.#sourceAttention(runtime);
        const incident = this.#incidentContext(source, taskOnBoard);
        const snapshot = await this.lifecycle.start({
          blueprintPath: incidentBlueprintPath,
          initialContext: { incident },
          instanceId: runtime.incidentId,
        });
        await this.#synchronizeSnapshot(runtime, snapshot, tasks);
        return;
      }
      const context = readLifecycleContext(record);
      let snapshot: Pick<LifecycleContextRecord, "awaitingNodeIds" | "status"> =
        context;
      if (context.pendingTransition !== null) {
        const pending = context.pendingTransition;
        snapshot =
          pending.kind === "start"
            ? await this.lifecycle.start({
                blueprintPath: context.blueprintPath,
                instanceId: runtime.incidentId,
              })
            : await this.lifecycle.resume({
                disposition: pending.disposition!,
                instanceId: runtime.incidentId,
                operationId: pending.operationId!,
                ...(pending.output === null ? {} : { output: pending.output }),
              });
      }
      await this.#synchronizeSnapshot(runtime, snapshot, tasks);
    } catch (error) {
      await this.#fail(runtime, error);
    }
  }

  async #synchronizeSnapshot(
    runtime: IncidentRuntimeRecord,
    snapshot: Pick<LifecycleContextRecord, "awaitingNodeIds" | "status">,
    tasks: readonly BoardTask[],
  ): Promise<void> {
    const stageId = snapshot.awaitingNodeIds[0];
    if (stageId === undefined) {
      if (snapshot.status !== "completed") {
        throw new Error("Incident lifecycle stopped without completion");
      }
      const stableId = `${runtime.incidentId}:resolve`;
      this.persistence.recordEffectIntent(finalizeEffect, stableId, {
        attentionId: runtime.attentionId,
        incidentId: runtime.incidentId,
      });
      this.persistence.resolveAttention(
        runtime.attentionId,
        runtime.incidentId,
      );
      this.persistence.recordEffectCompleted(finalizeEffect, stableId);
      this.persistence.writeIncidentRuntime({ ...runtime, state: "done" });
      return;
    }
    if (runtime.stageId === stageId && runtime.state === "waiting") return;
    if (stageId === "finalize") {
      if (!runtime.accepted) {
        throw new Error("Incident finalization requires accepted diagnosis");
      }
      if (
        incidentProposedActionKinds(runtime).has("github-issue") &&
        !(await (this.options.commandAvailable ?? executableOnPath)("gh"))
      ) {
        throw new Error(
          "Incident finalize prerequisite is missing from PATH: gh",
        );
      }
      if (
        incidentProposedActionKinds(runtime).has("production-mutation") &&
        !incidentProductionMutationApproved(this.persistence, runtime)
      ) {
        const approval = incidentProductionMutationApproval(runtime);
        if (!(await this.attention.has(approval.attentionId))) {
          await this.attention.raise(approval);
        } else {
          this.attention.reopen(approval.attentionId);
        }
        return;
      }
    }
    const source = this.#sourceAttention(runtime);
    const incident = this.#incidentContext(
      source,
      tasks.some(({ id }) => id === runtime.taskId),
    );
    const task = taskForIncident(this.persistence, tasks, source, incident);
    const starting =
      runtime.stageId === stageId && runtime.state === "starting"
        ? runtime
        : this.instances.prepareIncidentStart(
            {
              ...runtime,
              provider: undefined,
              sessionKey: undefined,
              stageEnteredAt: undefined,
              stageId: undefined,
              state: "starting",
              threadId: undefined,
            },
            stageId,
          );
    await this.instances.activateIncident(task, starting, stageId);
  }

  #assertFinalizationAuthorized(runtime: IncidentRuntimeRecord): void {
    if (!runtime.accepted) {
      throw new Error("Incident finalization requires accepted diagnosis");
    }
    if (!incidentProposedActionKinds(runtime).has("production-mutation"))
      return;
    if (!incidentProductionMutationApproved(this.persistence, runtime)) {
      throw new Error(
        "Incident production mutation requires accepted operator approval",
      );
    }
  }

  #sourceAttention(runtime: IncidentRuntimeRecord): ProductionErrorAttention {
    const record = this.persistence.getAttention(runtime.attentionId);
    const source =
      record === undefined ? undefined : productionError(record.payload);
    if (source === undefined) {
      throw new Error(
        `Incident source attention is unavailable: ${runtime.attentionId}`,
      );
    }
    return source;
  }

  #incidentContext(
    source: ProductionErrorAttention,
    taskOnBoard: boolean,
  ): JsonValue {
    const correlationTokens = this.persistence
      .listInstances()
      .flatMap(({ state }) => Object.values(state.correlationTokens));
    const observations = { ...source } as Record<string, JsonValue>;
    for (const key of [
      "attentionId",
      "code",
      "error",
      "incidentId",
      "instanceId",
      "kind",
      "message",
      "taskId",
    ]) {
      delete observations[key];
    }
    return sanitizeIncidentValue(
      {
        attentionId: source.attentionId,
        code: source.code,
        error: source.error,
        incidentId: productionErrorIncidentId(source.attentionId),
        message: source.message,
        observations: {
          ...observations,
          sourceInstanceId: source.instanceId,
          taskOnBoard,
        },
        recheck: {
          instruction: "Observe the source condition again before diagnosis",
        },
      },
      [...(this.options.secrets ?? []), ...correlationTokens],
    );
  }

  async #fail(runtime: IncidentRuntimeRecord, error: unknown): Promise<void> {
    this.persistence.writeIncidentRuntime({ ...runtime, state: "failed" });
    const failure = createProductionErrorAttention({
      attentionId: `production:incident-execution-failed:task:${runtime.taskId}:${runtime.incidentId}`,
      code: "incident-execution-failed",
      error,
      instanceId: runtime.incidentId,
      message: `Incident ${runtime.incidentId} failed`,
      taskId: runtime.taskId,
    });
    if (!(await this.attention.has(failure.attentionId))) {
      await this.attention.raise(failure);
    }
  }
}
